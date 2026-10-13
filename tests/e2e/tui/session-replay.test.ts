import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

function recordingPayload(path: string): { metadata: { sessionId: string }; gzip: string }[] {
	const html = readFileSync(path, "utf8")
	const document = html.match(/id="terminal-replay-document" type="application\/octet-stream">([^<]+)/)?.[1]
	if (!document) throw new Error("Export did not contain a terminal replay")
	const player = Buffer.from(document, "base64").toString("utf8")
	const payload = player.match(/const recordings = (.*);/)?.[1]
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
