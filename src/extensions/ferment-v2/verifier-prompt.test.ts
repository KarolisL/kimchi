import { execFile as execFileCallback } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import { buildVerifierTaskPrompt, type FermentV2VerifierFacts, gatherVerifierFacts } from "./verifier-prompt.js"

const execFile = promisify(execFileCallback)
const tempDirs: string[] = []

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function git(cwd: string, args: readonly string[]): Promise<void> {
	await execFile("git", args, { cwd, encoding: "utf-8" })
}

const todos: TodoItem[] = [
	{ id: 1, status: "in_progress", content: "Implement feature A", activeForm: "Implementing feature A" },
	{ id: 2, status: "completed", content: "Write tests", note: "Evidence: ran vitest" },
]

describe("gatherVerifierFacts", () => {
	it("reports unavailable outside a git repository", async () => {
		const facts = await gatherVerifierFacts("/nonexistent-definitely-not-a-repo")
		expect(facts.available).toBe(false)
		expect(facts.changedFiles).toEqual([])
	})

	it("gathers branch, head, and changed files inside this repository", async () => {
		const facts = await gatherVerifierFacts(process.cwd())
		expect(facts.available).toBe(true)
		expect(facts.git.branch).toBeTruthy()
		expect(facts.git.head).toMatch(/^[0-9a-f]{40}$/)
		// This test file itself is untracked or modified in the working tree, so at
		// least one changed file must be reported — robust regardless of git state.
		expect(facts.git.uncommittedFiles).toBe(facts.changedFiles.length)
		for (const file of facts.changedFiles) {
			expect(["A", "M", "D", "R"]).toContain(file.status)
			expect(file.path.length).toBeGreaterThan(0)
		}
	})

	it("reports unstaged, staged, renamed, and untracked files with blank status columns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-verifier-facts-"))
		tempDirs.push(dir)
		await git(dir, ["init", "-q"])
		await git(dir, ["config", "user.email", "test@example.com"])
		await git(dir, ["config", "user.name", "Test"])
		writeFileSync(join(dir, "unstaged.txt"), "original\n")
		writeFileSync(join(dir, "staged.txt"), "original\n")
		writeFileSync(join(dir, "renamed.txt"), "rename me\n")
		await git(dir, ["add", "-A"])
		await git(dir, ["commit", "-q", "-m", "initial"])
		// An unstaged modification (" M"), a staged modification ("M "), a staged
		// rename ("R " followed by the bare source field), and an untracked file ("??").
		writeFileSync(join(dir, "unstaged.txt"), "modified\n")
		writeFileSync(join(dir, "staged.txt"), "modified\n")
		await git(dir, ["add", "staged.txt"])
		await git(dir, ["mv", "renamed.txt", "moved.txt"])
		writeFileSync(join(dir, "untracked.txt"), "fresh\n")

		const facts = await gatherVerifierFacts(dir)

		expect(facts.available).toBe(true)
		expect(facts.changedFiles).toEqual(
			expect.arrayContaining([
				{ status: "M", path: "unstaged.txt" },
				{ status: "M", path: "staged.txt" },
				{ status: "R", path: "moved.txt", from: "renamed.txt" },
				{ status: "A", path: "untracked.txt" },
			]),
		)
		// The rename source field must be consumed, never reported as its own entry.
		expect(facts.changedFiles.map((file) => file.path)).not.toContain("renamed.txt")
	})
})

describe("buildVerifierTaskPrompt", () => {
	const facts: FermentV2VerifierFacts = {
		available: true,
		changedFiles: [
			{ status: "M", path: "src/a.ts" },
			{ status: "A", path: "src/new.test.ts" },
		],
		git: { branch: "main", head: "abc123def456", uncommittedFiles: 2 },
	}

	it("carries the objective, facts, and todos", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Implement the login flow",
			cwd: "/workspace",
			facts,
			todos,
		})
		expect(prompt).toContain("Implement the login flow")
		expect(prompt).toContain("modified: src/a.ts")
		expect(prompt).toContain("added: src/new.test.ts")
		expect(prompt).toContain("branch main")
		expect(prompt).toContain("Implement feature A")
		expect(prompt).toContain("Write tests")
		expect(prompt).toContain("derive every check from this")
		expect(prompt).toContain("[eN] evidence IDs")
	})

	it("notes unavailable facts outside git", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Research the API",
			cwd: "/tmp",
			facts: { available: false, changedFiles: [], git: { uncommittedFiles: 0 } },
			todos: [],
		})
		expect(prompt).toContain("not a git repository")
		expect(prompt).toContain("(no Todos)")
	})

	it("includes the proposed answer, confidence and previous gap when present", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Return the uppercase form",
			cwd: "/workspace",
			facts,
			todos,
			completionConfidence: "proven",
			proposedAnswer: "THE ANSWER",
			previousGap: "Remaining requirement: exact output.",
		})
		expect(prompt).toContain("proven (low trust")
		expect(prompt).toContain("THE ANSWER")
		expect(prompt).toContain("Previous verifier gap")
		expect(prompt).toContain("Remaining requirement: exact output.")
	})

	it("includes Todo notes so the verifier sees the implementer's recorded evidence", () => {
		const prompt = buildVerifierTaskPrompt({ objective: "Do it", cwd: "/workspace", facts, todos })
		expect(prompt).toContain("(note: Evidence: ran vitest)")
	})

	it("omits optional sections when absent", () => {
		const prompt = buildVerifierTaskPrompt({ objective: "Do it", cwd: "/workspace", facts, todos: [] })
		expect(prompt).not.toContain("completion confidence")
		expect(prompt).not.toContain("Proposed final answer")
		expect(prompt).not.toContain("Previous verifier gap")
	})
})
