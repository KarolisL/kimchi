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

	it("renders baseline facts: changed files, diff stat, git state, and flagged test changes with IDs", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				...facts,
				baselineCommit: "baseline-123",
				workspace: {
					baseline: "baseline-1234567890",
					changedFiles: facts.changedFiles,
					diffStat: " src/a.ts | 2 +-\n 2 files changed",
					testInventoryFlags: [
						{ id: "f1", kind: "test_file_deleted", path: "src/old.test.ts" },
						{
							id: "f2",
							kind: "skip_marker_added",
							path: "src/a.test.ts",
							detail: "it.skip('works')",
						},
					],
					testInventoryIncomplete: false,
					git: { branch: "main", head: "abc123", commitsSinceBaseline: 2, uncommittedFiles: 2 },
					truncated: true,
				},
			},
			todos: [],
		})
		expect(prompt).toContain("compared against the baseline baseline-123")
		expect(prompt).toContain("modified: src/a.ts")
		expect(prompt).toContain("Diff stat vs baseline")
		expect(prompt).toContain("2 commit(s) since baseline")
		expect(prompt).toContain("truncated by the host")
		expect(prompt).toContain("- f1: test file deleted — src/old.test.ts")
		expect(prompt).toContain("- f2: skip marker added — src/a.test.ts (it.skip('works'))")
		expect(prompt).toContain("must be addressed by some check's flags array")
	})

	it("tells the verifier when the test inventory could not be collected completely", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: {
				...facts,
				baselineCommit: "baseline-123",
				workspace: {
					baseline: "baseline-1234567890",
					changedFiles: facts.changedFiles,
					diffStat: "",
					testInventoryFlags: [{ id: "f1", kind: "test_file_modified", path: "src/a.test.ts" }],
					testInventoryIncomplete: true,
					git: { branch: "main", head: "abc123", commitsSinceBaseline: 0, uncommittedFiles: 2 },
					truncated: false,
				},
			},
			todos: [],
		})
		expect(prompt).toContain("could not collect the test inventory completely")
		expect(prompt).toContain("inspect the changed test files yourself")
	})

	it("carries the baseline worktree path with the attribution and vacuous-test steps and the traps", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Fix the bug",
			cwd: "/workspace",
			facts: { ...facts, baselineCommit: "base123", baselineWorktree: "/tmp/kimchi-ferment-v2-baseline-x" },
			todos: [],
		})
		expect(prompt).toContain("Baseline worktree (host-provided, disposable): /tmp/kimchi-ferment-v2-baseline-x")
		expect(prompt).toContain("pre-existing, not caused by the implementer's changes")
		expect(prompt).toContain("they must FAIL there")
		expect(prompt).toContain("does not verify the change")
		// The verifier must be able to transfer the implementer's new tests into
		// the worktree (they do not exist at the baseline) while the production
		// code stays pre-change, and must tell assertion failures from setup ones.
		expect(prompt).toContain("copy the implementer's new or changed test files into the baseline worktree")
		expect(prompt).toContain("never commit anything inside the worktree")
		expect(prompt).toContain("an assertion failure is the strong evidence")
		expect(prompt).toContain("inconclusive")
		expect(prompt).toContain("editable install")
		expect(prompt).toContain("generated files")
		expect(prompt).toContain("nested node_modules")
	})

	it("explains a missing baseline (comparison basis and worktree) instead of staying silent", () => {
		const noBaseline = buildVerifierTaskPrompt({ objective: "Do it", cwd: "/workspace", facts, todos: [] })
		expect(noBaseline).toContain("no baseline snapshot was captured")
		expect(noBaseline).toContain("listed against HEAD")
		const failedDiff = buildVerifierTaskPrompt({
			objective: "Do it",
			cwd: "/workspace",
			facts: { ...facts, baselineCommit: "base123" },
			todos: [],
		})
		expect(failedDiff).toContain("baseline diff could not be computed")
		expect(failedDiff).toContain("Baseline worktree: unavailable")
	})

	it("tells the verifier when the baseline comparison failed so no inventory was collected", () => {
		const prompt = buildVerifierTaskPrompt({
			objective: "Do it",
			cwd: "/workspace",
			facts: { ...facts, baselineCommit: "base123", testInventoryUnavailable: true },
			todos: [],
		})
		expect(prompt).toContain("baseline diff could not be computed")
		expect(prompt).toContain("the test inventory could not be collected at all")
		expect(prompt).toContain("inspect the changed test files yourself")
		// No flags were collected on this path — the flag section must stay
		// absent rather than imply a clean inventory.
		expect(prompt).not.toContain("Test-inventory flags")
	})
})
