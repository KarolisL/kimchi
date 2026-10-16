/**
 * verifier-prompt.ts — the Ferment V2 verifier's per-run task prompt and the
 * host-gathered workspace facts it receives.
 *
 * Until requirements exist (the drafting slice), the verifier derives its
 * checks from the objective; the prompt therefore carries the objective, the
 * git facts of the working tree — against the ferment **baseline** when one
 * exists (changed files, diff stat, test-inventory flags with `f1…` IDs),
 * against HEAD otherwise — the path of the host-provided baseline worktree
 * with the attribution and vacuous-test steps and the known worktree traps,
 * the implementer's Todos (low-trust context), the proposed final answer,
 * and the previous verifier gap.
 */

import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2CompletionConfidence } from "./types.js"
import type { TestInventoryFlag, WorkspaceFacts } from "./workspace.js"

const execFile = promisify(execFileCallback)
const GIT_COMMAND_TIMEOUT_MS = 15_000
const MAX_CHANGED_FILES = 200

export interface FermentV2VerifierChangedFile {
	status: "A" | "M" | "D" | "R"
	path: string
	from?: string
}

export interface FermentV2VerifierFacts {
	/** True when the facts were gathered successfully (false outside git). */
	available: boolean
	changedFiles: FermentV2VerifierChangedFile[]
	git: { branch?: string; head?: string; uncommittedFiles: number }
	/** The ferment baseline commit the facts were compared against; set whenever a baseline exists. */
	baselineCommit?: string
	/** Full workspace facts against the baseline; absent when the baseline diff could not be computed. */
	workspace?: WorkspaceFacts
	/**
	 * True when a baseline exists but its comparison failed outright, so these
	 * vs-HEAD facts carry no workspace section and the test-inventory flags
	 * were never collected — an absent flag list on this path means "not
	 * collected", never "clean". The host rejects a `met` verdict while it is
	 * set, until a run collects the inventory successfully.
	 */
	testInventoryUnavailable?: boolean
	/** Absolute path of the host-provided baseline worktree for this run; absent when creation failed. */
	baselineWorktree?: string
}

export const EMPTY_FERMENT_V2_VERIFIER_FACTS: FermentV2VerifierFacts = {
	available: false,
	changedFiles: [],
	git: { uncommittedFiles: 0 },
}

/** Characters legal in either porcelain-v1 status column, including the unmodified blank. */
const PORCELAIN_STATUS_CHARS = new Set([" ", "M", "A", "D", "R", "C", "U", "T", "?", "!"])

function parsePorcelain(raw: string): FermentV2VerifierChangedFile[] {
	const fields = raw.split("\0").filter((entry) => entry.length > 0)
	const files: FermentV2VerifierChangedFile[] = []
	for (let i = 0; i < fields.length; i++) {
		// "XY <path>" — with -z, rename/copy entries are followed by the source
		// path as a bare NUL-separated field (no XY prefix), consumed
		// structurally below so it is never mistaken for an entry of its own.
		const entry = fields[i]
		if (entry.length < 4 || entry[2] !== " ") continue
		const x = entry[0]
		const y = entry[1]
		if (!PORCELAIN_STATUS_CHARS.has(x) || !PORCELAIN_STATUS_CHARS.has(y)) continue
		const path = entry.slice(3)
		if (!path) continue
		const from = x === "R" || x === "C" ? fields[++i] : undefined
		if (x === "R" || x === "C" || y === "R") {
			files.push({ status: "R", path, ...(from ? { from } : {}) })
		} else if (x === "A" || y === "A" || x === "?" || y === "?") {
			files.push({ status: "A", path })
		} else if (x === "D" || y === "D") {
			files.push({ status: "D", path })
		} else {
			files.push({ status: "M", path })
		}
	}
	return files.slice(0, MAX_CHANGED_FILES)
}

/** Gather changed files and git state (vs HEAD) for the verifier prompt. Host-only, read-only. */
export async function gatherVerifierFacts(cwd: string, signal?: AbortSignal): Promise<FermentV2VerifierFacts> {
	const run = async (args: readonly string[]): Promise<string | undefined> => {
		try {
			const { stdout } = await execFile("git", args, {
				cwd,
				timeout: GIT_COMMAND_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf-8",
				...(signal ? { signal } : {}),
			})
			return stdout
		} catch {
			return undefined
		}
	}
	const [status, branch, head] = await Promise.all([
		run(["status", "--porcelain=v1", "-z"]),
		run(["rev-parse", "--abbrev-ref", "HEAD"]),
		run(["rev-parse", "--verify", "HEAD"]),
	])
	if (status === undefined && branch === undefined && head === undefined) return EMPTY_FERMENT_V2_VERIFIER_FACTS
	const changedFiles = status === undefined ? [] : parsePorcelain(status)
	return {
		available: true,
		changedFiles,
		git: {
			branch: branch?.trim() || undefined,
			head: head?.trim() || undefined,
			uncommittedFiles: changedFiles.length,
		},
	}
}

function formatChangedFile(file: FermentV2VerifierChangedFile): string {
	const label =
		file.status === "A" ? "added" : file.status === "D" ? "deleted" : file.status === "R" ? "renamed" : "modified"
	return `- ${label}: ${file.path}${file.from ? ` (from ${file.from})` : ""}`
}

function formatTestInventoryFlag(flag: TestInventoryFlag): string {
	const kind = flag.kind.replaceAll("_", " ")
	return `- ${flag.id}: ${kind} — ${flag.path}${flag.detail ? ` (${flag.detail})` : ""}${
		flag.requirementId ? ` [requirement ${flag.requirementId}]` : ""
	}`
}

function formatTodoState(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "(no Todos)"
	return todos.map((todo) => `- [${todo.status}] ${todo.content}${todo.note ? ` (note: ${todo.note})` : ""}`).join("\n")
}

/** Renders the facts section: baseline comparison when available, vs-HEAD fallback otherwise. */
function formatFactsSection(facts: FermentV2VerifierFacts): string {
	if (!facts.available) {
		return [
			"Working tree facts (host-gathered):",
			"(unavailable — not a git repository; there is no baseline snapshot, no test-inventory flag list, and no baseline worktree; inspect the directory directly)",
		].join("\n")
	}
	const workspace = facts.workspace
	if (workspace) {
		const gitState = [
			workspace.git.branch ? `branch ${workspace.git.branch}` : undefined,
			workspace.git.head ? `HEAD ${workspace.git.head.slice(0, 12)}` : undefined,
			workspace.git.commitsSinceBaseline !== undefined
				? `${workspace.git.commitsSinceBaseline} commit(s) since baseline`
				: undefined,
			`${workspace.git.uncommittedFiles} uncommitted file change(s)`,
		]
			.filter(Boolean)
			.join(", ")
		const changedFiles = workspace.changedFiles.length
			? workspace.changedFiles.map(formatChangedFile).join("\n")
			: "(no changed files vs baseline)"
		const lines = [
			`Working tree facts (host-gathered, compared against the baseline ${workspace.baseline.slice(0, 12)} captured when the objective started — untracked files included):`,
			changedFiles,
		]
		if (workspace.diffStat) lines.push(`Diff stat vs baseline:\n${workspace.diffStat}`)
		lines.push(`git state: ${gitState}`)
		if (workspace.truncated) {
			lines.push("(the changed-file list or the diff stat was truncated by the host)")
		}
		if (workspace.testInventoryFlags.length > 0) {
			lines.push(
				[
					"Test-inventory flags (host-detected changes to the pre-existing test suite; a met verdict requires every flag ID addressed by some check's flags array):",
					...workspace.testInventoryFlags.map(formatTestInventoryFlag),
				].join("\n"),
			)
		}
		if (workspace.testInventoryIncomplete) {
			lines.push(
				"(the host could not collect the test inventory completely — the flag list may be missing pre-existing test deletions, renames, modifications, or added skip/only markers; inspect the changed test files yourself)",
			)
		}
		return lines.join("\n")
	}
	const basis = facts.baselineCommit
		? "no baseline comparison is available for this run (the baseline diff could not be computed) — listed against HEAD"
		: "no baseline snapshot was captured for this objective — listed against HEAD"
	const gitState = [
		facts.git.branch ? `branch ${facts.git.branch}` : undefined,
		facts.git.head ? `HEAD ${facts.git.head.slice(0, 12)}` : undefined,
		`${facts.git.uncommittedFiles} uncommitted file change(s)`,
	]
		.filter(Boolean)
		.join(", ")
	const changedFiles = facts.changedFiles.length
		? facts.changedFiles.map(formatChangedFile).join("\n")
		: "(no changed files vs HEAD)"
	const lines = [`Working tree facts (host-gathered; ${basis}):`, changedFiles, `git state: ${gitState}`]
	if (facts.testInventoryUnavailable) {
		lines.push(
			"(the test inventory could not be collected at all — there is no flag list and the host cannot validate a completion claim against the baseline yet; inspect the changed test files yourself)",
		)
	}
	return lines.join("\n")
}

/** Renders the baseline-worktree section with the attribution and vacuous-test steps and the known traps. */
function formatBaselineWorktreeSection(path: string): string {
	return [
		`Baseline worktree (host-provided, disposable): ${path}`,
		[
			"The working tree exactly as it was when the objective started, including files that were untracked then. Run code there to:",
			"- Attribute test failures: run the same failing test in the baseline worktree — a failure that also fails there is pre-existing, not caused by the implementer's changes; a failure that passes there is a regression.",
			"- Vacuous-test check: copy the implementer's new or changed test files into the baseline worktree, then run them there — they must FAIL there. A new test that passes without the implementer's changes does not verify the change. Distinguish how they fail: an assertion failure is the strong evidence; a test that only fails with a setup or import error (a module that did not exist at baseline, a missing fixture) is weaker, and a test that cannot run at all is inconclusive — treat it as unverified and look for an assertion-level failure instead.",
			"The worktree is disposable and always deleted after this run: you may copy the implementer's new or changed test files into it and run whatever setup those tests need (installs, generators, configuration), but keep the pre-change production code intact — never edit, add, or delete its source files, and never commit anything inside the worktree.",
			"Known traps: a Python editable install (pip -e) points at the main tree, not the worktree — reinstall inside the worktree or treat its baseline results as unreliable; generated files (build output, snapshots, lockfile-derived artifacts) may be stale or absent — regenerate them inside the worktree when cheap; only the repository root's node_modules is shared — a nested node_modules inside a subdirectory is not linked.",
		].join("\n"),
	].join("\n")
}

export interface FermentV2VerifierTaskInput {
	objective: string
	cwd: string
	facts: FermentV2VerifierFacts
	todos: readonly TodoItem[]
	/** The implementer's self-reported completion confidence (low trust). */
	completionConfidence?: FermentV2CompletionConfidence
	/** The proposed final answer (last tool-free assistant entry), when one exists. */
	proposedAnswer?: string
	/** The task-facing reason of the previous verifier `continue` verdict, when one exists. */
	previousGap?: string
}

/** Build the verifier's task prompt: objective, facts, low-trust context, and the output contract. */
export function buildVerifierTaskPrompt(input: FermentV2VerifierTaskInput): string {
	const sections: string[] = []
	sections.push(`Objective (derive every check from this):\n${input.objective}`)
	sections.push(formatFactsSection(input.facts))
	if (input.facts.baselineWorktree) {
		sections.push(formatBaselineWorktreeSection(input.facts.baselineWorktree))
	} else if (input.facts.available && input.facts.baselineCommit) {
		// A baseline exists but its worktree could not be created: the verifier
		// must know attribution cannot lean on a clean pre-change checkout.
		sections.push(
			"Baseline worktree: unavailable for this run (creation failed) — attribute pre-existing failures by reverting the implementer's changes by hand only when that is cheap and safe, and treat attribution as uncertain otherwise.",
		)
	}
	sections.push(`Implementer's current Todos (context only, self-reported):\n${formatTodoState(input.todos)}`)
	if (input.completionConfidence) {
		sections.push(
			`Implementer's self-reported completion confidence: ${input.completionConfidence} (low trust — verify everything).`,
		)
	}
	if (input.proposedAnswer !== undefined) {
		sections.push(
			`Proposed final answer (the complete last tool-free assistant message; compare final-answer requirements against it literally):\n${input.proposedAnswer}`,
		)
	}
	if (input.previousGap) {
		sections.push(`Previous verifier gap (already reported to the implementer):\n${input.previousGap}`)
	}
	sections.push(
		[
			"Now execute your verification procedure: derive the requirements from the objective, run your checks in the working tree,",
			"and end with exactly one JSON object matching the output contract. Cite only [eN] evidence IDs stamped on your tool results.",
			...(input.facts.workspace?.testInventoryFlags.length
				? [
						"Every test-inventory flag ID listed above must be addressed by some check's flags array before a met verdict is accepted.",
					]
				: []),
		].join(" "),
	)
	return sections.join("\n\n")
}
