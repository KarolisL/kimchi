/**
 * verifier-guard.ts — the Ferment V2 verifier's evidence stamping and
 * workspace integrity guard.
 *
 * The guard runs as an inline extension inside the verifier subagent's child
 * session (it loads even though the Verifier persona disables extensions):
 *
 * - every `tool_result` is prefixed with a host-stamped evidence ID `[eN]`;
 *   verdicts may cite only these IDs (host validation rejects unknown IDs);
 * - assistant usage is accumulated per `message_end`, and summarization usage
 *   per `session_compact` (the compaction completion produces no assistant
 *   message), both including cost — so upstream compaction, which rewrites the
 *   session's messages, cannot erase the usage of discarded messages;
 * - `snapshotWorkspace` captures the working tree through a temporary index
 *   (never touching the real index, tree, or refs);
 * - `enforceWorkspaceIntegrity` runs after the verifier (including on abort):
 *   modified/deleted pre-existing files are restored, files the verifier added
 *   are removed, and HEAD moves — branch switches and detachments, even at the
 *   same commit, including transitions to or from an unborn HEAD (`git checkout
 *   --orphan`) — are detected without git surgery.
 */

import { execFile as execFileCallback } from "node:child_process"
import { copyFileSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { Usage } from "@earendil-works/pi-ai"
import type { InlineExtension } from "@earendil-works/pi-coding-agent"
import { isRecord } from "./reducer.js"
import type { FermentV2EvaluatorUsage } from "./types.js"

const execFile = promisify(execFileCallback)

/** Per-git-command timeout. 15s bounds a snapshot on large repos; past it the fact is unavailable. */
const GIT_COMMAND_TIMEOUT_MS = 15_000
/** Maximum characters of a tool result kept as the evidence excerpt. */
const EVIDENCE_EXCERPT_CHARS = 2_000

export interface VerifierEvidence {
	id: string
	toolName: string
	input: Record<string, unknown>
	isError: boolean
	excerpt: string
}

export interface VerifierGuard {
	extension: InlineExtension
	evidence: ReadonlyMap<string, VerifierEvidence>
	/**
	 * Verifier usage accumulated per assistant `message_end` and per
	 * `session_compact` event, including cost. Event-based accumulation
	 * survives upstream compaction, which rewrites `session.messages` and
	 * would drop the usage of discarded messages; the compaction completion
	 * itself bills tokens no assistant message ever carries.
	 */
	usage: FermentV2EvaluatorUsage
}

function textExcerpt(content: readonly unknown[]): string {
	const text = content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim()
	return text.length > EVIDENCE_EXCERPT_CHARS ? `${text.slice(0, EVIDENCE_EXCERPT_CHARS)}…` : text
}

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path)
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * The verifier's in-session guard: every tool result is stamped with a
 * sequential evidence ID, and usage is accumulated as assistant messages
 * complete and as compactions run, so it can be counted even after compaction.
 */
export function createVerifierGuard(): VerifierGuard {
	const evidence = new Map<string, VerifierEvidence>()
	const usage: FermentV2EvaluatorUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
	}
	let nextEvidenceId = 1

	const addUsage = (u: Usage): void => {
		usage.input += u.input ?? 0
		usage.output += u.output ?? 0
		usage.cacheRead += u.cacheRead ?? 0
		usage.cacheWrite += u.cacheWrite ?? 0
		usage.totalTokens += u.totalTokens ?? 0
		usage.costUsd += u.cost?.total ?? 0
	}

	const extension: InlineExtension = (pi) => {
		pi.on("tool_result", (event) => {
			const id = `e${nextEvidenceId++}`
			evidence.set(id, {
				id,
				toolName: event.toolName,
				input: event.input,
				isError: event.isError,
				excerpt: textExcerpt(event.content),
			})
			const content = event.content.map((part) =>
				part.type === "text" ? { ...part, text: `[${id}] ${part.text}` } : part,
			)
			return { content }
		})
		// Compaction runs a separate summarization completion that produces no
		// assistant message — its billed usage surfaces only on this event.
		pi.on("session_compact", (event) => {
			if (event.compactionEntry.usage) addUsage(event.compactionEntry.usage)
		})
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return
			const u = (event.message as { usage?: Usage }).usage
			if (u) addUsage(u)
		})
	}

	return { extension, evidence, usage }
}

export interface WorkspaceSnapshot {
	commit: string
	tree: string
}

export interface SnapshotDiff {
	modified: string[]
	deleted: string[]
	added: string[]
}

interface GitRunner {
	run(args: readonly string[], options?: { env?: Record<string, string>; signal?: AbortSignal }): Promise<string>
}

function createGitRunner(cwd: string): GitRunner {
	return {
		async run(args, options) {
			const { stdout } = await execFile("git", args, {
				cwd,
				timeout: GIT_COMMAND_TIMEOUT_MS,
				maxBuffer: 64 * 1024 * 1024,
				encoding: "utf-8",
				...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
				...(options?.signal ? { signal: options.signal } : {}),
			})
			return stdout
		},
	}
}

/**
 * HEAD of the workspace: a commit, or an unborn branch (fresh `git init`,
 * `git checkout --orphan`). A commit carries the symbolic ref HEAD is
 * attached to (absent when detached), so a branch switch or detachment at
 * the same commit is still a HEAD move.
 */
export type HeadState = { kind: "commit"; sha: string; ref?: string } | { kind: "unborn"; ref: string }

/**
 * Resolve HEAD: a commit, an unborn branch, or undefined when git could not
 * answer (timeout, broken repository). An unborn HEAD also fails
 * `rev-parse --verify HEAD`; `symbolic-ref` distinguishes it from a repo
 * where git cannot resolve HEAD at all — and, for a resolved commit, an
 * attached from a detached HEAD.
 */
async function readHeadState(git: GitRunner, signal?: AbortSignal): Promise<HeadState | undefined> {
	try {
		const sha = (await git.run(["rev-parse", "--verify", "HEAD"], { signal })).trim()
		if (sha) {
			try {
				const ref = (await git.run(["symbolic-ref", "-q", "HEAD"], { signal })).trim()
				if (ref) return { kind: "commit", sha, ref }
			} catch {
				// Detached HEAD: `symbolic-ref` fails, so the commit carries no ref.
			}
			return { kind: "commit", sha }
		}
	} catch {
		try {
			const ref = (await git.run(["symbolic-ref", "-q", "HEAD"], { signal })).trim()
			if (ref) return { kind: "unborn", ref }
		} catch {}
	}
	return undefined
}

/** HEAD state of the workspace, or undefined when git could not resolve it. */
export async function workspaceHead(cwd: string, signal?: AbortSignal): Promise<HeadState | undefined> {
	return readHeadState(createGitRunner(cwd), signal)
}

/**
 * Heads match only when the commit and the symbolic-ref target (branch, or
 * detached on both sides) are unchanged — a branch switch or a detachment
 * at the same commit is a HEAD move.
 */
function sameHeadState(before: HeadState, after: HeadState): boolean {
	if (before.kind === "commit" && after.kind === "commit") return before.sha === after.sha && before.ref === after.ref
	if (before.kind === "unborn" && after.kind === "unborn") return before.ref === after.ref
	return false
}

/** Whether cwd is inside a git work tree, a confirmed non-repo, or undeterminable. */
export type GitWorkspaceProbe = "git" | "outside_git" | "unknown"

/**
 * Probe whether cwd is inside a git work tree. "outside_git" is a confirmed
 * non-repo; "unknown" means git could not answer (missing binary, timeout,
 * broken repository). "unknown" must fail closed — an undeterminable
 * workspace cannot be protected by the integrity guard.
 */
export async function detectGitWorkspace(cwd: string, signal?: AbortSignal): Promise<GitWorkspaceProbe> {
	try {
		await createGitRunner(cwd).run(["rev-parse", "--show-toplevel"], { signal })
		return "git"
	} catch (error) {
		return isNotARepositoryError(error) ? "outside_git" : "unknown"
	}
}

function isNotARepositoryError(error: unknown): boolean {
	const stderr = (error as { stderr?: unknown }).stderr
	return typeof stderr === "string" && stderr.includes("not a git repository")
}

/**
 * Snapshot the working tree (including untracked, non-ignored files) as a tree
 * and commit object, without touching the real index, tree, or refs: the real
 * index is copied to a temporary file, `git add -A` runs against that copy,
 * and `git write-tree` + `git commit-tree` produce the snapshot (parentless
 * when HEAD is unborn). Returns undefined outside git or when any step
 * fails; callers must have confirmed a git workspace first and treat
 * undefined as failure.
 */
export async function snapshotWorkspace(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot | undefined> {
	const git = createGitRunner(cwd)
	let indexFile: string | undefined
	let tempDir: string | undefined
	try {
		const realIndex = (await git.run(["rev-parse", "--git-path", "index"], { signal })).trim()
		// git-path returns a path relative to cwd when inside the work tree.
		const realIndexPath = isAbsolute(realIndex) ? realIndex : resolve(cwd, realIndex)
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-snapshot-"))
		indexFile = join(tempDir, "index")
		// A missing index (fresh repository): git creates a fresh empty index
		// when the target does not exist.
		copyIndexFile(realIndexPath, indexFile)
		// The bits copied from the real index must go: git add -A ignores edits
		// to skip-worktree/assume-unchanged files, so both the before- and
		// after-run snapshots would record the stale blob and the guard would
		// leave a verifier modification in place.
		await clearSnapshotIndexFlags(cwd, indexFile, signal)
		await git.run(["add", "-A", "--"], { env: { GIT_INDEX_FILE: indexFile }, signal })
		const tree = (await git.run(["write-tree"], { env: { GIT_INDEX_FILE: indexFile }, signal })).trim()
		if (!tree) return undefined
		const head = await readHeadState(git, signal)
		const commit = (
			await git.run(
				[
					"commit-tree",
					tree,
					...(head?.kind === "commit" ? ["-p", head.sha] : []),
					"-m",
					"kimchi ferment-v2 verifier workspace snapshot",
				],
				{ env: { GIT_INDEX_FILE: indexFile }, signal },
			)
		).trim()
		if (!commit) return undefined
		return { commit, tree }
	} catch {
		return undefined
	} finally {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true })
	}
}

/** Copy the repository's index to the snapshot's temporary index. */
function copyIndexFile(from: string, to: string): void {
	try {
		copyFileSync(from, to)
	} catch {
		// A missing source (fresh repository) or unreadable index: start from a
		// fresh index — git creates the file when it does not exist, but rejects
		// a zero-byte one as "index file smaller than expected".
		rmSync(to, { force: true })
	}
}

/** Paths per `git update-index` invocation, bounding argv length on large clearings. */
const UPDATE_INDEX_BATCH = 100

/**
 * Clear `skip-worktree` (ls-files tag `S`) and `assume-unchanged` (lowercase
 * tags) bits in the snapshot's temporary index copy, so `git add -A` records
 * the actual working-tree content of those files. Only the temporary copy is
 * modified — the real index keeps the user's bits untouched.
 *
 * Both commands scope to the directory they run from: `ls-files` run from a
 * session subdirectory lists only that subtree, so a flagged entry elsewhere
 * (at the repository root, say) would keep its bit in the temporary index and
 * hide the verifier's edit from both snapshots. Enumeration and clearing
 * therefore run from the repository root, over root-relative paths — the
 * temp-index `git add -A`, `write-tree`, and `commit-tree` that follow are
 * already whole-tree from any cwd.
 *
 * Two separate invocations are required: passing both flags to one
 * `git update-index` command exits 0 but silently leaves the skip-worktree
 * bit set, hiding the verifier's edit from both snapshots (reproduced on
 * git 2.54; `git restore` shows the same skip-worktree filtering, covered
 * by `--ignore-skip-worktree-bits` in `restorePaths`).
 */
async function clearSnapshotIndexFlags(cwd: string, indexFile: string, signal?: AbortSignal): Promise<void> {
	const rootGit = createGitRunner(await workspaceRoot(cwd, signal))
	const tagged = await rootGit.run(["ls-files", "-v", "-z"], { env: { GIT_INDEX_FILE: indexFile }, signal })
	const flagged: string[] = []
	for (const entry of tagged.split("\0")) {
		const separator = entry.indexOf(" ")
		if (separator <= 0) continue
		const tag = entry.slice(0, separator)
		if (tag === "S" || /^[a-z]$/.test(tag)) flagged.push(entry.slice(separator + 1))
	}
	if (flagged.length === 0) return
	for (const clearFlag of ["--no-skip-worktree", "--no-assume-unchanged"]) {
		for (let start = 0; start < flagged.length; start += UPDATE_INDEX_BATCH) {
			const batch = flagged.slice(start, start + UPDATE_INDEX_BATCH)
			await rootGit.run(["update-index", clearFlag, "--", ...batch], {
				env: { GIT_INDEX_FILE: indexFile },
				signal,
			})
		}
	}
}

/** Parse `git diff-tree -r -z --name-status` output. */
function parseNameStatus(raw: string): { status: string; path: string; newPath: string | undefined }[] {
	const fields = raw.split("\0")
	const entries: { status: string; path: string; newPath: string | undefined }[] = []
	for (let i = 0; i < fields.length - 1; ) {
		const status = fields[i]
		if (!status) {
			i++
			continue
		}
		const kind = status[0]
		if (kind === "R" || kind === "C") {
			const oldPath = fields[i + 1]
			const newPath = fields[i + 2]
			if (!oldPath || !newPath) break
			entries.push({ status, path: oldPath, newPath })
			i += 3
		} else {
			const path = fields[i + 1]
			if (!path) break
			entries.push({ status, path, newPath: undefined })
			i += 2
		}
	}
	return entries
}

/** Diff two workspace snapshots by tree, classifying paths as modified, deleted, or added. */
export async function diffSnapshots(
	cwd: string,
	from: WorkspaceSnapshot,
	to: WorkspaceSnapshot,
	signal?: AbortSignal,
): Promise<SnapshotDiff> {
	const git = createGitRunner(cwd)
	const raw = await git.run(["diff-tree", "-r", "-z", "--name-status", from.tree, to.tree], { signal })
	const modified: string[] = []
	const deleted: string[] = []
	const added: string[] = []
	for (const { status, path, newPath } of parseNameStatus(raw)) {
		const kind = status[0]
		if (kind === "A") added.push(path)
		else if (kind === "D") deleted.push(path)
		else if ((kind === "R" || kind === "C") && newPath !== undefined) {
			deleted.push(path)
			added.push(newPath)
		} else modified.push(path)
	}
	return { modified, deleted, added }
}

/** Paths per `git restore` invocation, bounding argv length on large restorations. */
const RESTORE_PATHS_BATCH = 100

/**
 * Resolve the work tree root that snapshot and diff paths are relative to.
 * `git diff-tree` emits repository-root-relative paths regardless of the
 * session cwd, so filesystem operations must anchor to this root.
 */
async function workspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const root = (await createGitRunner(cwd).run(["rev-parse", "--show-toplevel"], { signal })).trim()
	if (!root) throw new Error("git rev-parse --show-toplevel returned no work tree root")
	return root
}

/**
 * Restore paths from a snapshot's tree into the working tree with
 * `git restore --source` — raw blob bytes, file modes, and symlink semantics
 * included — without touching the real index, so the user's staging state
 * survives. Paths are repository-root-relative and resolved against the work
 * tree root, never the session cwd. `--ignore-skip-worktree-bits` makes the
 * restore reach files git filters out of pathspec matching because the index
 * carries their skip-worktree bit (the flag exists since git 2.23, the version
 * that introduced `git restore` itself).
 */
export async function restorePaths(
	cwd: string,
	from: WorkspaceSnapshot,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const git = createGitRunner(await workspaceRoot(cwd, signal))
	for (let start = 0; start < paths.length; start += RESTORE_PATHS_BATCH) {
		const batch = paths.slice(start, start + RESTORE_PATHS_BATCH)
		await git.run(["restore", "--ignore-skip-worktree-bits", "--source", from.tree, "--worktree", "--", ...batch], {
			signal,
		})
	}
}

/** Remove files the verifier added (repository-root-relative paths), pruning directories that become empty. */
export async function removePaths(cwd: string, paths: readonly string[]): Promise<void> {
	const root = await workspaceRoot(cwd)
	for (const path of paths) {
		const absolute = resolve(root, path)
		rmSync(absolute, { force: true })
		let dir = dirname(absolute)
		while (dir !== root && isInside(dir, root)) {
			try {
				if (readdirSync(dir).length > 0) break
				rmdirSync(dir)
				dir = dirname(dir)
			} catch {
				break
			}
		}
	}
}

export interface IntegrityResult {
	violated: boolean
	restored: string[]
	removed: string[]
	headMoved: boolean
	/** Snapshot commit of the working tree right after the run — recovery point for the user. */
	postRunSnapshot?: string
	/** True when the workspace is not a git repo and integrity could not be enforced. */
	unenforced?: boolean
}

/**
 * Enforce workspace integrity after a verifier run (also on abort): snapshot
 * the current tree, restore modified/deleted pre-existing files from the
 * before-run snapshot, remove files the verifier added, and detect HEAD moves
 * — including transitions between resolved and unborn HEAD — without
 * attempting git surgery.
 */
export async function enforceWorkspaceIntegrity(
	cwd: string,
	before: WorkspaceSnapshot,
	beforeHead: HeadState | undefined,
	signal?: AbortSignal,
): Promise<IntegrityResult> {
	const git = createGitRunner(cwd)
	const after = await snapshotWorkspace(cwd, signal)
	if (!after) return { violated: false, restored: [], removed: [], headMoved: false, unenforced: true }
	const result: IntegrityResult = {
		violated: false,
		restored: [],
		removed: [],
		headMoved: false,
		postRunSnapshot: after.commit,
	}
	// HEAD must resolve after the run: a resolution failure is an enforcement
	// failure (it throws) rather than a clean tree. Any HEAD move is a
	// violation: a different commit or symbolic ref, a branch switch or
	// detachment at the same commit, or a transition between resolved and
	// unborn HEAD (e.g. `git checkout --orphan`).
	const afterHead = await readHeadState(git, signal)
	if (afterHead === undefined) throw new Error("git HEAD could not be resolved after the verifier run")
	if (beforeHead !== undefined && !sameHeadState(beforeHead, afterHead)) {
		result.headMoved = true
		result.violated = true
	}
	// A failed diff is an enforcement failure, not a clean tree: it propagates
	// so the host can discard an untrusted `met` verdict.
	const diff = await diffSnapshots(cwd, before, after, signal)
	const toRestore = [...diff.modified, ...diff.deleted]
	if (toRestore.length > 0) {
		await restorePaths(cwd, before, toRestore, signal)
		result.restored = toRestore
		result.violated = true
	}
	if (diff.added.length > 0) {
		await removePaths(cwd, diff.added)
		result.removed = diff.added
	}
	return result
}
