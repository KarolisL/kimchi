import { readFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { addTerminalReplay } from "./export.js"
import type { Recording } from "./recorder.js"

const cast = `${JSON.stringify({ version: 3, term: { cols: 120, rows: 40 } })}\n${JSON.stringify([0.12, "o", '\x1b[2Jraw draft </script><img src="https://example.invalid/leak">'])}\n`
const recording: Recording = {
	gzip: gzipSync(cast).toString("base64"),
	metadata: {
		version: 1,
		id: "recording",
		sessionId: "session",
		pid: 0,
		startedAt: "2026-10-13T10:00:00Z",
		status: "size-limit",
		cols: 120,
		rows: 40,
		chunks: 1,
		rawBytes: Buffer.byteLength(cast),
		compressedBytes: 120,
		duration: 0.12,
		queueHighWaterBytes: 200,
	},
}

describe("HTML terminal replay", () => {
	it("embeds the actual output offline, behind an isolated player, without changing the transcript", async () => {
		const transcript = '<div id="messages">redacted transcript</div>'
		const html = await addTerminalReplay(`<html><body>${transcript}</body></html>`, [recording])
		expect(html).toContain(transcript)
		expect(html).toContain('sandbox="allow-scripts allow-downloads"')
		expect(html).not.toContain("raw draft")
		const encoded = html.match(/id="terminal-replay-document" type="application\/octet-stream">([^<]+)/)?.[1]
		expect(encoded).toBeTruthy()
		if (!encoded) throw new Error("Replay document missing")
		const player = Buffer.from(encoded, "base64").toString("utf8")
		expect(player).toContain("unredacted")
		expect(player).toContain("Incomplete: recording stopped at the storage limit.")
		expect(player).toContain("Original pauses preserved")
		expect(player).toContain("connect-src 'none'")
		expect(player).not.toMatch(/<script[^>]+src=/)
		expect(player).not.toContain("/* RECORDINGS */")
		const payload = player.match(/id="recordings" type="application\/json">([^<]+)/)?.[1]
		if (!payload) throw new Error("Replay payload missing")
		const data = JSON.parse(payload)
		expect(gunzipSync(Buffer.from(data[0].gzip, "base64")).toString("utf8")).toBe(cast)
		expect(player).toContain("Apache License")
		expect(player).toContain("Copyright (c) 2018 Marcin Kulik")
		expect(player).toContain('<script id="licenses" type="application/json">')
		expect(player).not.toContain("Standalone distribution used without modification.")
	})

	it("explains missing coverage without loading player assets", async () => {
		const html = await addTerminalReplay("<body>old session</body>", [])
		expect(html).toContain("Terminal replay unavailable")
		expect(html).not.toContain("asciinema")
		expect(html).toContain("old session")
	})

	it("keeps the pinned standalone player assets unchanged", async () => {
		const { createHash } = await import("node:crypto")
		const js = readFileSync(
			new URL("../../resources/terminal-replay/generated/asciinema-player.min.js", import.meta.url),
		)
		expect(createHash("sha256").update(js).digest("hex")).toBe(
			"a13c37632e1b5c49fe9128417b9319a9b5bc64cb457dd5ae52cbba8a3aceb880",
		)
	})
})
