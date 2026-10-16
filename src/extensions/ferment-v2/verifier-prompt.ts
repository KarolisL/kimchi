/**
 * verifier-prompt.ts — the Ferment V2 verifier's per-run task prompt and the
 * host-gathered workspace facts it receives.
 *
 * Until requirements exist (the drafting slice), the verifier derives its
 * checks from the objective; the prompt therefore carries the objective, the
 * git facts of the working tree, the implementer's Todos (low-trust context),
 * the proposed final answer, and the previous verifier gap.
 */

import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import type { TodoItem } from "../todos/types.js"
import type { FermentV2CompletionConfidence } from "./types.js"

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

function formatTodoState(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "(no Todos)"
	return todos.map((todo) => `- [${todo.status}] ${todo.content}${todo.note ? ` (note: ${todo.note})` : ""}`).join("\n")
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
	if (input.facts.available) {
		const gitState = [
			input.facts.git.branch ? `branch ${input.facts.git.branch}` : undefined,
			input.facts.git.head ? `HEAD ${input.facts.git.head.slice(0, 12)}` : undefined,
			`${input.facts.git.uncommittedFiles} uncommitted file change(s)`,
		]
			.filter(Boolean)
			.join(", ")
		const changedFiles = input.facts.changedFiles.length
			? input.facts.changedFiles.map(formatChangedFile).join("\n")
			: "(no changed files vs HEAD)"
		sections.push(`Working tree facts (host-gathered):\n${changedFiles}\ngit state: ${gitState}`)
	} else {
		sections.push(
			"Working tree facts (host-gathered):\n(unavailable — not a git repository; inspect the directory directly)",
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
		].join(" "),
	)
	return sections.join("\n\n")
}
