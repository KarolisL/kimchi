/**
 * evaluator.ts — the Ferment V2 executing verifier.
 *
 * When the implementer claims completion, the host spawns the `Verifier`
 * subagent (read/bash/grep/find/ls, unlimited turns and duration, model-only
 * inactivity) with an inline guard extension that stamps every tool result
 * with an evidence ID `[eN]` and accumulates the session's usage as
 * assistant messages complete (compaction-proof). The verifier executes
 * checks in the real working tree; the host validates its JSON verdict
 * (citations must exist in the guard's evidence), keeps final-answer checks
 * as literal host comparisons, enforces workspace integrity after the run
 * (also on abort), and returns a `FermentV2EvaluationResult`. The verifier
 * only runs when the workspace's integrity can be protected: a git workspace
 * that cannot be snapshotted fails closed before spawning.
 *
 * The previous single-shot `completeSimple` call over a transcript digest is
 * gone; `evaluateFermentV2` and the result shape remain the seam used by
 * `index.ts`.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../../llm-gateway-error.js"
import {
	type FermentV2VerifierAgentRun,
	resumeFermentV2VerifierAgent,
	spawnFermentV2VerifierAgent,
} from "../agents/index.js"
import { getRedactionConfig } from "../pii-redaction/config.js"
import piiRedactionExtension from "../pii-redaction/index.js"
import { redactTextOrThrow } from "../pii-redaction/redactor.js"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2EvaluatorFailureType } from "./domain-events.js"
import { latestFinalAnswerDraft } from "./final-answer.js"
import { objectiveText } from "./objective-file.js"
import { isRecord } from "./reducer.js"
import { getFermentV2Settings } from "./settings.js"
import type { FermentV2Baseline, FermentV2CompletionConfidence, FermentV2EvaluatorUsage } from "./types.js"
import {
	createVerifierGuard,
	enforceWorkspaceIntegrity,
	type IntegrityResult,
	type VerifierEvidence,
	type VerifierGuard,
} from "./verifier-guard.js"
import { resolveFermentV2VerifierModel } from "./verifier-model.js"
import { buildVerifierTaskPrompt, type FermentV2VerifierFacts, gatherVerifierFacts } from "./verifier-prompt.js"
import {
	type BaselineWorktree,
	createBaselineWorktree,
	detectGitWorkspace,
	type GitWorkspaceProbe,
	gatherWorkspaceFacts,
	type HeadState,
	snapshotWorkspace,
	type TestInventoryFlag,
	type WorkspaceSnapshot,
	workspaceHead,
} from "./workspace.js"

const MAX_REASON_CHARS = 1_000

/** Maximum characters of a failing check's evidence excerpt embedded in the task-facing reason (design: ≤300). */
const FAILING_CHECK_EXCERPT_CHARS = 300

/** Backoff between transient verifier failures (design: ≈5s/20s/60s). */
const VERIFIER_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

/** Failure reasons that are transient: the verifier is retried up to 3× with backoff. */
const TRANSIENT_FAILURE_REASONS = new Set(["rate_limit", "transport_failure", "stream_interrupted", "provider_5xx"])

const INVALID_OUTPUT_CORRECTION_PROMPT =
	'The previous response was rejected by host validation: {reason} Return exactly one valid JSON object matching the output contract and nothing else. Cite only [eN] evidence IDs that appear in your tool results. Every "pass" check needs cited evidence and a failureMode; a "continue" verdict needs at least one cited "fail" check; an "impossible" verdict needs at least one check citing executed evidence; when the task lists test-inventory flag IDs, a met verdict needs every flag addressed in some check\'s flags array.'

export type FermentV2EvaluatorVerdict = "continue" | "met" | "impossible"

export interface FermentV2EvaluatorDiagnostics {
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	timeoutCount: number
	correctionCount: number
	/** Tool calls executed by the verifier session. */
	toolCalls?: number
	/** Turns used by the verifier session. */
	turns?: number
	failureType?: FermentV2EvaluatorFailureType
	httpStatusCode?: number
}

export type FermentV2EvaluationResult =
	| {
			verdict: FermentV2EvaluatorVerdict
			reason: string
			model: string
			usage: FermentV2EvaluatorUsage
			diagnostics: FermentV2EvaluatorDiagnostics
			acceptedFinalAnswer?: string
			sameModelAsImplementer?: boolean
			modelFallback?: "session"
			unusableEvaluatorRefs?: readonly string[]
			/** Workspace integrity outcome of this verifier run. */
			integrity?: IntegrityResult
	  }
	| {
			verdict: "unavailable"
			reason: string
			model?: string
			usage?: FermentV2EvaluatorUsage
			diagnostics: FermentV2EvaluatorDiagnostics
			sameModelAsImplementer?: boolean
			modelFallback?: "session"
			unusableEvaluatorRefs?: readonly string[]
			/** Workspace integrity outcome of this verifier run. */
			integrity?: IntegrityResult
	  }

export interface FermentV2EvaluationInput {
	objective: string
	/** The verifier child session's working directory (the real working tree). */
	cwd: string
	/** The implementer's conversation — used only to derive the proposed final answer. */
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	todos: readonly TodoItem[]
	completionConfidence?: FermentV2CompletionConfidence
	/** Task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
	/** The ferment's baseline snapshot — the fixed point the facts, the flags, and the baseline worktree anchor to. */
	baseline?: FermentV2Baseline
	/** Kept failing probes from earlier verifier runs, flagged when modified or deleted. */
	keptProbes?: readonly { path: string; requirementId: string }[]
	/** Fired once when the verifier run starts (after model resolution), for status-line UX. */
	onVerifierStart?: (info: { model: string }) => void
	signal?: AbortSignal
}

/** Options passed to the spawn seam. */
export interface FermentV2VerifierSpawnInput {
	model: Model<Api>
	prompt: string
	cwd: string
	extensionFactories: InlineExtension[]
	signal: AbortSignal
	/** Wall-clock cap in seconds; 0 = unlimited. */
	maxDuration: number
}

/** Injection seams so every validation branch is unit-testable without a real subagent. */
export interface FermentV2VerifierDeps {
	spawn?: (input: FermentV2VerifierSpawnInput) => Promise<FermentV2VerifierAgentRun | undefined>
	resume?: (id: string, prompt: string, signal: AbortSignal) => Promise<FermentV2VerifierAgentRun | undefined>
	/** Probes whether the workspace is a git work tree; defaults to detectGitWorkspace. */
	gitProbe?: (cwd: string, signal?: AbortSignal) => Promise<GitWorkspaceProbe>
	createGuard?: () => VerifierGuard
	snapshot?: (cwd: string, signal?: AbortSignal) => Promise<WorkspaceSnapshot | undefined>
	head?: (cwd: string, signal?: AbortSignal) => Promise<HeadState | undefined>
	facts?: (request: {
		cwd: string
		/** The ferment baseline commit; absent when no baseline was captured. */
		baseline?: string
		/** The before-run snapshot the baseline is diffed against (absent outside git). */
		current?: WorkspaceSnapshot
		keptProbes: readonly { path: string; requirementId: string }[]
		signal?: AbortSignal
	}) => Promise<FermentV2VerifierFacts>
	/** Creates the baseline worktree for the run; defaults to createBaselineWorktree. */
	createWorktree?: (cwd: string, baseline: string, signal?: AbortSignal) => Promise<BaselineWorktree | undefined>
	enforceIntegrity?: typeof enforceWorkspaceIntegrity
	redact?: (text: string) => Promise<string>
	/** Backoff sleep; the default ends early when the signal aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface FermentV2VerifierCheck {
	kind?: "work" | "final_answer"
	requirement: string
	status: "pass" | "fail" | "unverifiable"
	failureMode?: string
	candidateRef?: string
	observedAnswer?: string
	expectedAnswer?: string | null
	evidence: string[]
	/** Test-inventory flag IDs (f1, f2, …) this check addresses. */
	flags?: string[]
}

interface ParsedFermentV2EvaluatorOutput {
	verdict: FermentV2EvaluatorVerdict
	reason: string
	checks?: FermentV2VerifierCheck[]
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function emptyUsage(): FermentV2EvaluatorUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 }
}

/**
 * Backoff sleep that ends early when the signal aborts, so a timeout or
 * cancellation proceeds promptly to integrity cleanup instead of waiting out
 * the full delay.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer)
			resolve()
		}
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		if (signal?.aborted) {
			onAbort()
			return
		}
		signal?.addEventListener("abort", onAbort)
	})
}

function normalizeEvidenceId(evidence: string): string {
	const normalized = evidence.trim()
	return normalized.match(/^\[?(e\d+)\]?(?:\s|$)/i)?.[1]?.toLowerCase() ?? normalized
}

export function parseFermentV2EvaluatorOutput(raw: string): ParsedFermentV2EvaluatorOutput | undefined {
	for (const candidate of jsonObjects(raw)) {
		const value = candidate as unknown
		if (!isRecord(value)) continue
		if (value.verdict !== "continue" && value.verdict !== "met" && value.verdict !== "impossible") continue
		if (typeof value.reason !== "string" || !value.reason.trim()) continue
		const hasChecks = Object.hasOwn(value, "checks")
		const checks = parseChecks(value.checks)
		if (hasChecks && checks === undefined) continue
		// The reason stays the verifier's own task-facing summary here — the
		// failing-check composition needs the guard's evidence map and happens
		// in validation (failingCheckReason), not in parsing.
		return {
			verdict: value.verdict,
			reason: value.reason.trim().slice(0, MAX_REASON_CHARS),
			...(checks ? { checks } : {}),
		}
	}
	return undefined
}

function parseChecks(value: unknown): FermentV2VerifierCheck[] | undefined {
	if (!Array.isArray(value)) return undefined
	const checks: FermentV2VerifierCheck[] = []
	for (const candidate of value) {
		if (!isRecord(candidate) || typeof candidate.requirement !== "string" || !candidate.requirement.trim()) {
			return undefined
		}
		if (candidate.status !== "pass" && candidate.status !== "fail" && candidate.status !== "unverifiable") {
			return undefined
		}
		const evidence =
			(candidate.evidence === undefined || candidate.evidence === null) && candidate.kind === "final_answer"
				? []
				: candidate.evidence
		if (
			!Array.isArray(evidence) ||
			(candidate.kind !== undefined && candidate.kind !== "work" && candidate.kind !== "final_answer") ||
			(candidate.candidateRef !== undefined &&
				candidate.candidateRef !== null &&
				typeof candidate.candidateRef !== "string") ||
			(candidate.observedAnswer !== undefined &&
				candidate.observedAnswer !== null &&
				typeof candidate.observedAnswer !== "string") ||
			(candidate.kind === "final_answer" &&
				candidate.expectedAnswer !== null &&
				typeof candidate.expectedAnswer !== "string")
		) {
			return undefined
		}
		if (evidence.some((item) => typeof item !== "string" || !item.trim())) return undefined
		const flags = candidate.flags
		if (
			flags !== undefined &&
			(!Array.isArray(flags) || flags.some((item) => typeof item !== "string" || !item.trim().match(/^f\d+$/)))
		) {
			return undefined
		}
		checks.push({
			...(candidate.kind ? { kind: candidate.kind } : {}),
			requirement: candidate.requirement.trim(),
			status: candidate.status,
			...(typeof candidate.failureMode === "string" && candidate.failureMode.trim()
				? { failureMode: candidate.failureMode.trim() }
				: {}),
			...(typeof candidate.candidateRef === "string" ? { candidateRef: candidate.candidateRef } : {}),
			...(typeof candidate.observedAnswer === "string" ? { observedAnswer: candidate.observedAnswer } : {}),
			...(typeof candidate.expectedAnswer === "string" || candidate.expectedAnswer === null
				? { expectedAnswer: candidate.expectedAnswer }
				: {}),
			evidence: evidence.map(normalizeEvidenceId),
			...(flags !== undefined ? { flags: flags.map((item) => item.trim()) } : {}),
		})
	}
	return checks
}

/**
 * Yields each `{...}` run, pairing every `}` with its own opener via a stack so
 * unmatched braces in surrounding prose cannot swallow the verdict object. One
 * parse attempt per closing brace, rather than one per brace pair.
 */
function* jsonObjects(raw: string): Generator<unknown> {
	const starts: number[] = []
	let inString = false
	let escaped = false
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') inString = true
		else if (char === "{") starts.push(i)
		else if (char === "}") {
			const start = starts.pop()
			if (start === undefined) continue
			try {
				yield JSON.parse(raw.slice(start, i + 1))
			} catch {}
		}
	}
}

/** Evidence IDs cited by the verdict that the guard never stamped — hallucinated citations. */
function unknownEvidenceIds(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string[] {
	const unknown: string[] = []
	for (const check of checks ?? []) {
		for (const id of check.evidence) {
			if (!evidence.has(id) && !unknown.includes(id)) unknown.push(id)
		}
	}
	return unknown
}

/** Host reason when a `met` verdict is not backed by the verifier's own evidence. */
function unsupportedMetReason(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
	proposedAnswer: string | undefined,
): string | undefined {
	if (!checks?.length) return "Map each objective requirement to a check backed by executed evidence before finishing."
	for (const check of checks) {
		const requirement = JSON.stringify(check.requirement.slice(0, 200))
		if (check.status === "fail") {
			const excerpt = citedExcerpt(check, evidence)
			return `Requirement ${requirement} is not met; continue work and verify it.${excerpt ? ` Failing check: ${excerpt}.` : ""}`
		}
		if (check.kind === "final_answer") {
			if (
				proposedAnswer === undefined ||
				check.candidateRef !== "last_assistant" ||
				check.observedAnswer !== proposedAnswer
			) {
				return `Requirement ${requirement} has not been checked against the exact proposed answer; return only the required answer with no extra text.`
			}
			if (typeof check.expectedAnswer === "string" && proposedAnswer !== check.expectedAnswer) {
				return `Requirement ${requirement} requires exactly ${JSON.stringify(check.expectedAnswer)}; return that answer with no extra text.`
			}
			continue
		}
		if (check.status === "pass" && !check.failureMode) {
			return `Requirement ${requirement} does not name the plausible failure mode ruled out by its evidence; inspect the risk and verify it.`
		}
		if (check.evidence.length === 0) {
			return `Requirement ${requirement} has no cited evidence; run a relevant check and cite its [eN] result.`
		}
	}
	return undefined
}

/** A `continue` verdict needs at least one `fail` check citing evidence the guard stamped. */
function hasCitedFail(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): boolean {
	return checks?.some((check) => check.status === "fail" && check.evidence.some((id) => evidence.has(id))) ?? false
}

/** An `impossible` verdict blocks the ferment only with a check citing stamped evidence (design: ≥ 1 cited check). */
function hasCitedCheck(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): boolean {
	return checks?.some((check) => check.evidence.some((id) => evidence.has(id))) ?? false
}

/** A check's first stamped evidence excerpt, whitespace-flattened and clipped for a task-facing reason. */
function citedExcerpt(
	check: FermentV2VerifierCheck,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string | undefined {
	for (const id of check.evidence) {
		const excerpt = evidence.get(id)?.excerpt
		if (!excerpt) continue
		const flattened = excerpt.replace(/\s+/g, " ").trim()
		if (flattened) {
			return flattened.length > FAILING_CHECK_EXCERPT_CHARS
				? `${flattened.slice(0, FAILING_CHECK_EXCERPT_CHARS)}…`
				: flattened
		}
	}
	return undefined
}

/**
 * The task-facing reason for a verdict that keeps a failing check (plan
 * Chunk 8): the requirement plus the observed error from the check's cited
 * evidence. Returned results carry neither the checks nor their evidence, so
 * without this the implementer would never see what the verifier observed —
 * the excerpt is the diagnosis and the repair anchor. Falls back to the
 * verifier's own summary when no failing check cites a stamped, non-empty
 * excerpt.
 */
function failingCheckReason(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string | undefined {
	for (const check of checks ?? []) {
		if (check.status !== "fail") continue
		const excerpt = citedExcerpt(check, evidence)
		if (excerpt === undefined) continue
		const requirement = check.requirement.replace(/[.\s]+$/, "")
		return `Remaining requirement: ${requirement}. Failing check: ${excerpt}`
	}
	return undefined
}

type ValidatedVerdict =
	| { kind: "ok"; verdict: FermentV2EvaluatorVerdict; reason: string; acceptedFinalAnswer?: string }
	| { kind: "correct"; reason: string; failureType: FermentV2EvaluatorFailureType }

/** The first test-inventory flag no check addresses (in its flags array) — a `met` verdict must cover every flag. */
function unaddressedTestInventoryFlag(
	checks: readonly FermentV2VerifierCheck[] | undefined,
	testInventoryFlags: readonly TestInventoryFlag[],
): TestInventoryFlag | undefined {
	return testInventoryFlags.find((flag) => !checks?.some((check) => check.flags?.includes(flag.id)))
}

function validateParsedVerdict(
	parsed: ParsedFermentV2EvaluatorOutput,
	evidence: ReadonlyMap<string, VerifierEvidence>,
	proposedAnswer: string | undefined,
	testInventoryFlags: readonly TestInventoryFlag[],
	testInventoryIncomplete: boolean,
): ValidatedVerdict {
	// Every cited ID must match a stamped tool result before any verdict is
	// accepted — a hallucinated [eN] citation rejects the verdict.
	const unknown = unknownEvidenceIds(parsed.checks, evidence)
	if (unknown.length > 0) {
		if (parsed.verdict === "met") {
			// Mirrors an uncited `met`: downgraded to a host-authored `continue`.
			return {
				kind: "ok",
				verdict: "continue",
				reason: `The verdict cites evidence ID${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} that match no executed tool result; run the supporting check and cite its [eN] result.`,
			}
		}
		return {
			kind: "correct",
			reason: `the verdict cited unknown evidence ID${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`,
			failureType: "uncited_verdict",
		}
	}
	if (parsed.verdict === "met") {
		// An incomplete inventory is never a clean one: when git failed while
		// computing the baseline comparison — the whole diff, the baseline
		// test-file enumeration, or a changed-file marker diff — the flag list
		// may be missing entries or was not collected at all, so a `met`
		// verdict cannot be accepted on it.
		if (testInventoryIncomplete) {
			return {
				kind: "ok",
				verdict: "continue",
				reason:
					"The test inventory could not be collected completely (git failed while diffing the workspace against the baseline, enumerating baseline test files, or diffing changed ones), so this completion claim cannot be accepted yet — the flag list may be missing deleted, renamed, or modified test files or added skip/only markers, or was not collected at all; claim completion again so the host re-collects the inventory.",
			}
		}
		// A met verdict must address every host-detected test-inventory flag:
		// deleted, renamed, or modified pre-existing tests, added skip/only
		// markers, and kept-probe changes are the classic ways an implementer
		// makes a suite green without making it pass.
		const unaddressed = unaddressedTestInventoryFlag(parsed.checks, testInventoryFlags)
		if (unaddressed) {
			const described = `${unaddressed.kind.replaceAll("_", " ")}: ${unaddressed.path}${
				unaddressed.detail ? ` (${unaddressed.detail})` : ""
			}`
			return {
				kind: "ok",
				verdict: "continue",
				reason: `Flag ${unaddressed.id} (${described}) is not addressed by any check; address every test-inventory flag in a check's flags array before claiming completion.`,
			}
		}
		const unsupported = unsupportedMetReason(parsed.checks, evidence, proposedAnswer)
		if (unsupported) {
			// An uncited `met` is downgraded to a host-authored `continue`.
			return { kind: "ok", verdict: "continue", reason: unsupported }
		}
		return {
			kind: "ok",
			verdict: "met",
			reason: parsed.reason,
			...(parsed.checks?.some((check) => check.kind === "final_answer") && proposedAnswer !== undefined
				? { acceptedFinalAnswer: proposedAnswer }
				: {}),
		}
	}
	if (parsed.verdict === "continue" && !hasCitedFail(parsed.checks, evidence)) {
		return {
			kind: "correct",
			reason: "the verdict had no cited failing check.",
			failureType: "uncited_verdict",
		}
	}
	// Design (Chunk 8): "impossible: ≥ 1 cited check → blocked." An unsupported
	// impossible never blocks the ferment on its own say-so.
	if (parsed.verdict === "impossible" && !hasCitedCheck(parsed.checks, evidence)) {
		return {
			kind: "correct",
			reason: "the verdict had no cited check.",
			failureType: "uncited_verdict",
		}
	}
	// A verdict with a failing check keeps the composed task-facing gap
	// (requirement + observed error); without one the verifier's own
	// summary stands.
	return { kind: "ok", verdict: parsed.verdict, reason: failingCheckReason(parsed.checks, evidence) ?? parsed.reason }
}

/**
 * The default facts gatherer: workspace facts against the ferment baseline
 * when one exists and its diff can be computed — changed files including the
 * ones that were untracked at start, diff stat, git state, and the
 * test-inventory flags — and vs-HEAD facts otherwise (outside git, or when
 * the baseline diff failed; the prompt says which basis the verifier sees).
 */
async function defaultGatherVerifierFacts(request: {
	cwd: string
	baseline?: string
	current?: WorkspaceSnapshot
	keptProbes: readonly { path: string; requirementId: string }[]
	signal?: AbortSignal
}): Promise<FermentV2VerifierFacts> {
	if (!request.baseline || !request.current) return gatherVerifierFacts(request.cwd, request.signal)
	const workspace = await gatherWorkspaceFacts(
		request.cwd,
		request.baseline,
		request.current,
		request.keptProbes,
		request.signal,
	)
	if (!workspace) {
		return {
			...(await gatherVerifierFacts(request.cwd, request.signal)),
			baselineCommit: request.baseline,
			// The whole baseline comparison failed, so the inventory was never
			// collected — an absent flag list must never read as a clean one.
			// Validation rejects a `met` verdict until a run collects it.
			testInventoryUnavailable: true,
		}
	}
	return {
		available: true,
		changedFiles: workspace.changedFiles,
		git: {
			branch: workspace.git.branch,
			head: workspace.git.head,
			uncommittedFiles: workspace.git.uncommittedFiles,
		},
		baselineCommit: request.baseline,
		workspace,
	}
}

export async function evaluateFermentV2(
	input: FermentV2EvaluationInput,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	deps?: FermentV2VerifierDeps,
): Promise<FermentV2EvaluationResult> {
	const startedAt = Date.now()
	const settings = getFermentV2Settings()
	const evaluationTimeoutMs = settings.evaluationTimeoutMs
	const sleep = deps?.sleep ?? abortableSleep

	let providerRequestCount = 0
	let timeoutCount = 0
	let correctionCount = 0
	let toolCalls = 0
	let turns = 0
	let guard: VerifierGuard | undefined
	let worktree: BaselineWorktree | undefined
	let modelRef: string | undefined
	let sameModelAsImplementer: boolean | undefined
	let modelFallback: "session" | undefined
	let unusableEvaluatorRefs: readonly string[] | undefined

	const diagnostics = (
		failureType?: FermentV2EvaluatorFailureType,
		httpStatusCode?: number,
	): FermentV2EvaluatorDiagnostics => ({
		durationMs: Math.max(0, Date.now() - startedAt),
		timeoutMs: evaluationTimeoutMs ?? 0,
		providerRequestCount,
		timeoutCount,
		correctionCount,
		toolCalls,
		turns,
		...(failureType ? { failureType } : {}),
		...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
	})

	const baseResultFields = () => ({
		...(sameModelAsImplementer ? { sameModelAsImplementer } : {}),
		...(modelFallback ? { modelFallback } : {}),
		...(unusableEvaluatorRefs?.length ? { unusableEvaluatorRefs } : {}),
	})

	// The verifier's usage is accumulated by its in-session guard per assistant
	// message, so compaction rewriting the session messages cannot erase it.
	const verifierUsage = (): FermentV2EvaluatorUsage => (guard ? { ...guard.usage } : emptyUsage())

	const unavailable = (
		reason: string,
		failureType: FermentV2EvaluatorFailureType,
		httpStatusCode?: number,
	): FermentV2EvaluationResult => {
		const usage = verifierUsage()
		return {
			verdict: "unavailable",
			reason,
			...(modelRef ? { model: modelRef } : {}),
			...(usage.totalTokens > 0 || usage.costUsd > 0 ? { usage } : {}),
			diagnostics: diagnostics(failureType, httpStatusCode),
			...baseResultFields(),
		}
	}

	// Fail closed: the verifier runs only when the workspace's integrity can
	// be protected. A confirmed non-git workspace ("outside_git") runs without
	// integrity; a git workspace whose tree cannot be snapshotted — or whose
	// HEAD cannot be resolved — never spawns the verifier, so its verdicts
	// cannot certify a tree the host could not restore. An undeterminable
	// workspace ("unknown") fails closed the same way.
	if (input.signal?.aborted) return unavailable(`Verifier ${modelRef ?? "session model"} was cancelled.`, "cancelled")
	const gitProbe = await (deps?.gitProbe ?? detectGitWorkspace)(input.cwd, input.signal)
	if (gitProbe === "unknown") {
		return unavailable(
			"Workspace git state could not be determined, so the verifier did not run: the working tree could not be protected.",
			"integrity_unavailable",
		)
	}
	const before = gitProbe === "git" ? await (deps?.snapshot ?? snapshotWorkspace)(input.cwd, input.signal) : undefined
	if (gitProbe === "git" && !before) {
		return unavailable(
			"The working tree could not be snapshotted before the verifier run, so the verifier did not run: the working tree could not be protected.",
			"integrity_unavailable",
		)
	}
	const beforeHead = before ? await (deps?.head ?? workspaceHead)(input.cwd, input.signal) : undefined
	if (before && !beforeHead) {
		return unavailable(
			"Workspace HEAD could not be resolved before the verifier run, so the verifier did not run: HEAD moves could not be detected.",
			"integrity_unavailable",
		)
	}

	let result: FermentV2EvaluationResult
	try {
		result = await runVerifier()
	} catch (error) {
		if (input.signal?.aborted) {
			result = unavailable(`Verifier ${modelRef ?? "session model"} was cancelled.`, "cancelled")
		} else {
			const classified = classifyLLMGatewayError(errorMessage(error))
			result = unavailable(
				`Verifier ${modelRef ?? "session model"} failed: ${errorMessage(error)}`,
				classified?.reason ?? "call_failed",
				classified?.httpStatusCode,
			)
		}
	}

	// Integrity runs after every verifier run — verdict, error, and abort alike.
	// The (possibly aborted) input signal is deliberately not passed: the
	// restore must complete.
	if (before) {
		try {
			const integrity = await (deps?.enforceIntegrity ?? enforceWorkspaceIntegrity)(
				input.cwd,
				before,
				beforeHead,
				undefined,
			)
			result = applyIntegrity(result, integrity, diagnostics, baseResultFields)
		} catch (error) {
			// Integrity enforcement failed (e.g. a restore could not be written or
			// git disappeared mid-run): the working tree may still carry verifier
			// changes, so a `met` verdict cannot be trusted.
			result = discardMetOnEnforcementFailure(
				result,
				`could not be enforced (${errorMessage(error)})`,
				diagnostics,
				baseResultFields,
			)
		}
	}
	// The baseline worktree is disposed after every run — verdict, error, and
	// abort alike — once integrity has been enforced. Disposal is best-effort:
	// a leftover is pruned at the next session start.
	if (worktree) {
		const stale = worktree
		worktree = undefined
		try {
			await stale.dispose()
		} catch {
			// Removal failed (git vanished mid-run, say); nothing to retry here.
		}
	}
	return result

	async function runVerifier(): Promise<FermentV2EvaluationResult> {
		input.signal?.throwIfAborted()

		const modelChoice = await resolveFermentV2VerifierModel(ctx, settings.evaluatorModels)
		if (!modelChoice) return unavailable("No verifier model is available.", "no_model")
		const model = modelChoice.model
		modelRef = modelChoice.ref
		sameModelAsImplementer = modelChoice.sameAsImplementer || undefined
		modelFallback = modelChoice.fallback
		unusableEvaluatorRefs = modelChoice.unusableRefs

		guard = (deps?.createGuard ?? createVerifierGuard)()
		// Before every run: the host-provided baseline worktree the verifier
		// attributes failures and checks new tests in. A baseline implies a git
		// workspace (capture returns undefined outside git); `before` is the
		// fresh snapshot the facts are diffed against.
		if (input.baseline && before) {
			worktree = await (deps?.createWorktree ?? createBaselineWorktree)(input.cwd, input.baseline.commit, input.signal)
		}
		const facts = await (deps?.facts ?? defaultGatherVerifierFacts)({
			cwd: input.cwd,
			...(input.baseline ? { baseline: input.baseline.commit } : {}),
			...(before ? { current: before } : {}),
			keptProbes: input.keptProbes ?? [],
			signal: input.signal,
		})

		const proposedAnswer = latestFinalAnswerDraft(input.messages)
		let prompt = buildVerifierTaskPrompt({
			objective: objectiveText(input.objective, ctx.cwd),
			cwd: input.cwd,
			facts: { ...facts, ...(worktree ? { baselineWorktree: worktree.path } : {}) },
			todos: input.todos,
			...(input.completionConfidence ? { completionConfidence: input.completionConfidence } : {}),
			...(proposedAnswer !== undefined ? { proposedAnswer } : {}),
			...(input.previousGap ? { previousGap: input.previousGap } : {}),
		})
		if (getRedactionConfig().enabled) {
			try {
				prompt = await (deps?.redact ?? redactTextOrThrow)(prompt)
			} catch {
				return unavailable("Verifier input redaction failed.", "redaction_failed")
			}
		}

		const timeoutSignal = evaluationTimeoutMs ? AbortSignal.timeout(evaluationTimeoutMs) : undefined
		const runSignal = timeoutSignal
			? input.signal
				? AbortSignal.any([timeoutSignal, input.signal])
				: timeoutSignal
			: (input.signal ?? new AbortController().signal)
		// The spawn's wall-clock cap mirrors the optional timeout (0 = unlimited).
		const maxDuration = evaluationTimeoutMs ? Math.ceil(evaluationTimeoutMs / 1000) : 0

		input.onVerifierStart?.({ model: modelRef })
		const spawn = deps?.spawn ?? defaultSpawn
		let run: FermentV2VerifierAgentRun | undefined
		for (let attempt = 0; ; attempt++) {
			// The combined signal is checked before every attempt — including the
			// first and each retry after backoff — so a timeout that already fired
			// is never retried and cancellation proceeds to integrity cleanup.
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			providerRequestCount++
			// The Verifier persona disables extensions, so PII redaction rides
			// along as an inline factory (no-op when redaction is disabled). It
			// runs before the guard so the guard stamps — and records as evidence
			// excerpts for verdict reasons — already-redacted content.
			run = await spawn({
				model,
				prompt,
				cwd: input.cwd,
				extensionFactories: [piiRedactionExtension, guard.extension],
				signal: runSignal,
				maxDuration,
			})
			if (!run) return unavailable("The verifier subagent system is not available.", "agent_unavailable")
			toolCalls += run.toolCalls
			turns += run.turns
			if (run.status === "error") {
				const classified = classifyLLMGatewayError(run.error ?? "")
				if (
					classified &&
					TRANSIENT_FAILURE_REASONS.has(classified.reason) &&
					attempt < VERIFIER_RETRY_DELAYS_MS.length
				) {
					// The abortable backoff ends early on timeout/cancellation; the
					// loop-top check reports it instead of spawning again.
					await sleep(VERIFIER_RETRY_DELAYS_MS[attempt], runSignal)
					continue
				}
				return unavailable(
					`Verifier ${modelRef} run failed: ${run.error ?? "unknown error"}`,
					classified?.reason ?? "call_failed",
					classified?.httpStatusCode,
				)
			}
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			if (run.status === "aborted" || run.status === "stopped") {
				return unavailable(`Verifier ${modelRef} was aborted (${run.abortReason ?? run.status}).`, "call_failed")
			}
			break
		}
		const verifierRun = run

		// The flag list that validation runs against is never treated as clean
		// when it could not be collected — partially (a workspace comparison
		// marked it incomplete) or not at all (the baseline diff failed and the
		// facts degraded to vs-HEAD with no workspace section; zero flags there
		// mean "not collected", never "no flags").
		const testInventoryFlags = facts.workspace?.testInventoryFlags ?? []
		const testInventoryIncomplete =
			facts.workspace?.testInventoryIncomplete === true || facts.testInventoryUnavailable === true

		const parsed = parseFermentV2EvaluatorOutput(verifierRun.text)
		let validated = parsed
			? validateParsedVerdict(parsed, guard.evidence, proposedAnswer, testInventoryFlags, testInventoryIncomplete)
			: ({ kind: "correct", reason: "no valid JSON verdict was returned.", failureType: "invalid_output" } as const)
		if (validated.kind === "correct") {
			correctionCount++
			const corrected = await resumeWithRetries(
				verifierRun.id,
				INVALID_OUTPUT_CORRECTION_PROMPT.replace("{reason}", validated.reason),
				runSignal,
				verifierRun.toolCalls,
			)
			// A timeout is never retried and reported as such; the same cap covered the whole run.
			if (timeoutSignal?.aborted) {
				timeoutCount++
				return unavailable(
					`Verifier ${modelRef} timed out after ${(evaluationTimeoutMs ?? 0) / 1_000} seconds.`,
					"timeout",
				)
			}
			if (input.signal?.aborted) return unavailable(`Verifier ${modelRef} was cancelled.`, "cancelled")
			if (corrected === undefined) return unavailable(`Verifier ${modelRef} correction failed.`, "call_failed")
			if (corrected.status === "error") {
				const classified = classifyLLMGatewayError(corrected.error ?? "")
				return unavailable(
					`Verifier ${modelRef} correction failed: ${corrected.error ?? "unknown error"}`,
					classified?.reason ?? "call_failed",
					classified?.httpStatusCode,
				)
			}
			const reparsed = parseFermentV2EvaluatorOutput(corrected.text)
			validated = reparsed
				? validateParsedVerdict(reparsed, guard.evidence, proposedAnswer, testInventoryFlags, testInventoryIncomplete)
				: ({
						kind: "correct",
						reason: "no valid JSON verdict was returned after the correction.",
						failureType: "invalid_output",
					} as const)
			if (validated.kind === "correct") {
				return unavailable(`Verifier ${modelRef} ${validated.reason}`, validated.failureType)
			}
		}

		return {
			verdict: validated.verdict,
			reason: validated.reason,
			model: modelRef,
			usage: verifierUsage(),
			diagnostics: diagnostics(),
			...(validated.acceptedFinalAnswer ? { acceptedFinalAnswer: validated.acceptedFinalAnswer } : {}),
			...baseResultFields(),
		}
	}

	function defaultSpawn(spawnInput: FermentV2VerifierSpawnInput): Promise<FermentV2VerifierAgentRun | undefined> {
		return spawnFermentV2VerifierAgent(pi, ctx, spawnInput.prompt, {
			model: spawnInput.model,
			cwd: spawnInput.cwd,
			extensionFactories: spawnInput.extensionFactories,
			signal: spawnInput.signal,
			maxDuration: spawnInput.maxDuration,
		})
	}

	/**
	 * Resume the verifier session with the transient retry policy: transient
	 * provider errors are retried with backoff like the spawn, while timeouts
	 * and cancellations never retry. Returns the final run (an error run when
	 * the failure is not transient) or undefined when the run cannot continue.
	 *
	 * `baselineToolCalls` is the child record's cumulative tool-call count when
	 * the initial run ended; a resume returns that same record's cumulative
	 * count (the manager never resets it), so only the delta is counted.
	 */
	async function resumeWithRetries(
		id: string,
		prompt: string,
		signal: AbortSignal,
		baselineToolCalls: number,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		const resume = deps?.resume ?? defaultResume
		let cumulativeToolCalls = baselineToolCalls
		for (let attempt = 0; ; attempt++) {
			// Never resume again once the run was cancelled or timed out —
			// including after a backoff whose signal aborted mid-wait.
			if (input.signal?.aborted || signal.aborted) return undefined
			providerRequestCount++
			const run = await resume(id, prompt, signal)
			if (!run) return undefined
			if (run.toolCalls > cumulativeToolCalls) {
				toolCalls += run.toolCalls - cumulativeToolCalls
				cumulativeToolCalls = run.toolCalls
			}
			turns += run.turns
			if (run.status === "error") {
				// An aborted signal (timeout or cancellation) surfaces as an error
				// only in flight; it is never retried.
				if (input.signal?.aborted || signal.aborted) return run
				const classified = classifyLLMGatewayError(run.error ?? "")
				if (
					classified &&
					TRANSIENT_FAILURE_REASONS.has(classified.reason) &&
					attempt < VERIFIER_RETRY_DELAYS_MS.length
				) {
					await sleep(VERIFIER_RETRY_DELAYS_MS[attempt], signal)
					continue
				}
				return run
			}
			if (run.status === "aborted" || run.status === "stopped") return undefined
			if (input.signal?.aborted || signal.aborted) return undefined
			return run
		}
	}

	function defaultResume(
		id: string,
		prompt: string,
		signal: AbortSignal,
	): Promise<FermentV2VerifierAgentRun | undefined> {
		return resumeFermentV2VerifierAgent(id, prompt, { signal })
	}
}

/**
 * Integrity could not be enforced or established after a run whose before-run
 * snapshot exists: the working tree's post-run state is unknown, so a `met`
 * verdict is discarded with an explicit recovery note; every other verdict
 * stands (its continuation does not certify the tree).
 */
function discardMetOnEnforcementFailure(
	result: FermentV2EvaluationResult,
	detail: string,
	diagnostics: (failureType?: FermentV2EvaluatorFailureType, httpStatusCode?: number) => FermentV2EvaluatorDiagnostics,
	baseResultFields: () => Record<string, unknown>,
): FermentV2EvaluationResult {
	if (result.verdict !== "met") return result
	return {
		verdict: "unavailable",
		reason: `Verifier workspace integrity ${detail}, so its completion verdict was discarded. The working tree may still contain verifier changes; inspect it before continuing.`,
		...(result.model ? { model: result.model } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		diagnostics: diagnostics("guard_violation"),
		...baseResultFields(),
	}
}

/** Discard a `met` verdict on guard violation; keep every other verdict and attach the integrity outcome. */
function applyIntegrity(
	result: FermentV2EvaluationResult,
	integrity: IntegrityResult,
	diagnostics: (failureType?: FermentV2EvaluatorFailureType, httpStatusCode?: number) => FermentV2EvaluatorDiagnostics,
	baseResultFields: () => Record<string, unknown>,
): FermentV2EvaluationResult {
	if (!integrity.violated) {
		if (integrity.unenforced) {
			// A before-run snapshot exists, so `unenforced` means the post-run
			// snapshot failed — an enforcement failure, not a non-git workspace.
			return discardMetOnEnforcementFailure(
				result,
				"could not be established after the run",
				diagnostics,
				baseResultFields,
			)
		}
		return { ...result, integrity }
	}
	if (result.verdict === "met") {
		const restored = [...integrity.restored, ...integrity.removed].sort()
		const recovery = integrity.postRunSnapshot ? ` Post-run snapshot: ${integrity.postRunSnapshot}.` : ""
		return {
			verdict: "unavailable",
			reason: `The verifier modified the working tree, so its completion verdict was discarded. Restored files: ${restored.length ? restored.join(", ") : "(none)"}.${recovery}`,
			...(result.model ? { model: result.model } : {}),
			...(result.usage ? { usage: result.usage } : {}),
			diagnostics: diagnostics("guard_violation"),
			...baseResultFields(),
			integrity,
		}
	}
	return { ...result, integrity }
}
