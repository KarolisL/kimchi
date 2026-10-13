import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

function recordingPayload(
	path: string,
): { metadata: { sessionId: string; part: number; rawBytes: number }; gzip: string }[] {
	const html = readFileSync(path, "utf8")
	const document = html.match(/id="terminal-replay-document" type="application\/octet-stream">([^<]+)/)?.[1]
	if (!document) throw new Error("Export did not contain a terminal replay")
	const player = Buffer.from(document, "base64").toString("utf8")
	const payload = player.match(/id="recordings" type="application\/json">([^<]+)/)?.[1]
	if (!payload) throw new Error("Recording payload missing")
	return JSON.parse(payload)
}

function decodedCast(recording: { gzip: string }): string {
	return gunzipSync(Buffer.from(recording.gzip, "base64")).toString("utf8")
}

test.use(TUI_TEST_CONFIG)

test("exports recorded terminal output only after choosing replay", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-terminal-replay",
			responses: [
				{ stream: ["The visible output is ", "REPLAY_STREAM_COMPLETE."], textDelayMs: 150 },
				{ stream: ["SECOND_SESSION_REPLAY_READY."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Show the replay marker")
			await waitForText(terminal, "REPLAY_STREAM_COMPLETE.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.resize(100, 35)
			const htmlPath = join(fixture.workDir, "with-replay.html")
			terminal.submit(`/export ${htmlPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			trace.step("explicit raw-recording choice")
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*with-replay\.html/)
			const recordings = recordingPayload(htmlPath)
			const cast = decodedCast(recordings[recordings.length - 1])
			expect(cast).toContain("REPLAY_STREAM_COMPLETE")
			expect(cast).toContain('"r","100x35"')
			expect(cast).toContain("\\u001b[")
			trace.step("HTML contains actual output and resize")

			const transcriptPath = join(fixture.workDir, "transcript-only.html")
			terminal.submit(`/export ${transcriptPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*transcript-only\.html/)
			expect(readFileSync(transcriptPath, "utf8")).not.toContain('id="terminal-replay-document"')
			trace.step("default transcript-only choice excludes raw output")

			terminal.submit("/new")
			await waitForText(terminal, "New session started", { full: false })
			terminal.submit("Show the second session marker")
			await waitForText(terminal, "SECOND_SESSION_REPLAY_READY.")
			await waitForTurnToSettle(fixture.fake.requests)
			const nextPath = join(fixture.workDir, "next-session.html")
			terminal.submit(`/export ${nextPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*next-session\.html/)
			const next = recordingPayload(nextPath)
			expect(next).toHaveLength(1)
			expect(next[0].metadata.sessionId).not.toBe(recordings[0].metadata.sessionId)
			const nextCast = decodedCast(next[0])
			expect(nextCast).toContain("SECOND_SESSION_REPLAY_READY")
			expect(nextCast).not.toContain("REPLAY_STREAM_COMPLETE")
			trace.step("session replacement starts a fresh recording without old output")
		},
	)
})

test("keeps recording after a full part and exports the continued screen", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "session-replay-parts",
			responses: [{ stream: ["BEFORE_ROTATION_VISIBLE."] }],
			trustWorkDir: true,
			seedHome: (_home, workDir) => {
				const extensions = join(workDir, ".config/kimchi/harness/extensions")
				mkdirSync(extensions, { recursive: true })
				writeFileSync(
					join(extensions, "replay-part-burst.js"),
					readFileSync(new URL("./support/fixtures/replay-part-burst.js", import.meta.url)),
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("Show the marker before recording continues")
			await waitForText(terminal, "BEFORE_ROTATION_VISIBLE.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/replay-part-burst")
			await waitForText(terminal, "REPLAY_PART_TWO_READY", { timeoutMs: 35000 })
			trace.step("recording continued after the default 32 MiB part filled")
			const htmlPath = join(fixture.workDir, "continued-replay.html")
			terminal.submit(`/export ${htmlPath}`)
			await waitForText(terminal, "Include terminal replay?", { full: false })
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, /Session exported to:\s+\S*continued-replay\.html/)
			const parts = recordingPayload(htmlPath)
			expect(parts).toHaveLength(2)
			expect(parts[0].metadata.rawBytes).toBeGreaterThan(31 * 1024 * 1024)
			expect(parts[1].metadata.part).toBe(2)
			expect(decodedCast(parts[1])).toContain("BEFORE_ROTATION_VISIBLE")
			expect(decodedCast(parts[1])).toContain("REPLAY_PART_TWO_READY")
			trace.step("later part contains the preceding screen and subsequent terminal output")
		},
	)
})
