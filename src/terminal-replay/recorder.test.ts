import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import { type Recording, readRecordings, recordingDeadline, TerminalRecorder } from "./recorder.js"

function cast(recording: Recording): string {
	return gunzipSync(Buffer.from(recording.gzip, "base64")).toString("utf8")
}

const roots: string[] = []
async function root() {
	const path = await mkdtemp(join(tmpdir(), "kimchi-recording-"))
	roots.push(path)
	return path
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("terminal recording", () => {
	it("continues in bounded parts and retains the screen after earlier parts are evicted", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "five-day-session",
			cols: 30,
			rows: 8,
			limits: { slots: 2, rawBytes: 2048 },
			now: () => now,
		})
		recorder.write("\x1b[2J\x1b[H\x1b[2;1HDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界")
		await recorder.flush()
		for (let index = 0; index < 20; index++) {
			now += 6 * 60 * 60 * 1000
			recorder.write(`\x1b[6;1H\x1b[2K${"\x1b[0m".repeat(30)}update ${index}`)
			await recorder.flush()
		}
		await recorder.close()
		const recordings = await readRecordings(directory, "five-day-session")
		expect(recordings).toHaveLength(2)
		expect(cast(recordings[recordings.length - 1])).toContain("update 19")
		expect(recordings.every(({ metadata }) => metadata.rawBytes <= 2048)).toBe(true)
		expect(recordings.at(-1)?.metadata.status).toBe("complete")
		// The later part must retain the defect even when the part that drew it is gone.
		expect(cast(recordings[recordings.length - 1])).toContain("DUPLICATE BUG")
		expect(cast(recordings[recordings.length - 1])).toContain("界")
	})

	it("returns control if a disk operation stalls", async () => {
		const start = performance.now()
		expect(await recordingDeadline(new Promise(() => {}), 10)).toBeUndefined()
		expect(performance.now() - start).toBeLessThan(500)
	})

	it("continues at the compressed cap with resized geometry and relative timing", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "compressed-parts",
			cols: 30,
			rows: 8,
			limits: { compressedBytes: 800 },
			now: () => now,
		})
		recorder.resize(25, 7)
		for (let index = 0; index < 25; index++) {
			now += 1000
			recorder.write(`\x1b[2J\x1b[Hframe ${index}`)
			await recorder.flush()
		}
		await recorder.close()
		const recordings = await readRecordings(directory, "compressed-parts")
		expect(recordings.length).toBeGreaterThan(1)
		for (const [index, recording] of recordings.entries()) {
			expect(recording.metadata.compressedBytes).toBeLessThanOrEqual(800)
			expect(recording.metadata.part).toBe(index + 1)
			const [header, ...events] = cast(recording)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(events.reduce((sum, event) => sum + event[0], 0)).toBeCloseTo(recording.metadata.duration)
			if (index) expect(header.term).toEqual({ cols: 25, rows: 7 })
		}
		expect(recordings.reduce((sum, recording) => sum + recording.metadata.duration, 0)).toBe(25)
		expect(cast(recordings[recordings.length - 1])).toContain("frame 24")
	})

	it("reads a committed prefix after abrupt termination and ignores an unfinished final write", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "crashed", cols: 80, rows: 24 })
		recorder.write("saved before interruption")
		await recorder.flush()
		await appendFile(join(recorder.directory, "output.bin"), Buffer.from([0, 0, 255, 255, 31, 139]))
		const [recording] = await readRecordings(directory, "crashed")
		expect(cast(recording)).toContain("saved before interruption")
		expect(recording.metadata.status).toBe("recording")
		await recorder.close()
	})

	it("enforces the compressed cap without skipping a middle chunk", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "compressed",
			cols: 80,
			rows: 24,
			limits: { compressedBytes: 180 },
		})
		recorder.write("small prefix")
		await recorder.flush()
		recorder.write(Array.from({ length: 300 }, (_, i) => String.fromCharCode(32 + (i % 95))).join(""))
		await recorder.flush()
		recorder.write("later frame")
		await recorder.close()
		const [recording] = await readRecordings(directory, "compressed")
		expect(cast(recording)).toContain("small prefix")
		expect(cast(recording)).not.toContain("later frame")
		expect(recording.metadata.status).toBe("size-limit")
		expect((await stat(join(recorder.directory, "output.bin"))).size).toBeLessThanOrEqual(180)
	})

	it("excludes and prunes expired closed visits", async () => {
		const directory = await root()
		const first = await TerminalRecorder.create({ root: directory, sessionId: "expired", cols: 80, rows: 24 })
		await first.close()
		const path = join(first.directory, "metadata.json")
		const metadata = JSON.parse(await readFile(path, "utf8"))
		metadata.startedAt = "2000-01-01T00:00:00Z"
		await writeFile(path, JSON.stringify(metadata))
		expect(await readRecordings(directory, "expired")).toEqual([])
		const second = await TerminalRecorder.create({ root: directory, sessionId: "fresh", cols: 80, rows: 24 })
		await second.close()
		await expect(readFile(path, "utf8")).rejects.toThrow()
	})
	it("preserves output, relative timing and geometry through a persisted recording", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "session-a",
			cols: 120,
			rows: 40,
			now: () => now,
		})
		now = 120
		recorder.write("\x1b[2J\x1b[Hvisible defect: duplicated row\r\n")
		now = 2120
		recorder.resize(80, 24)
		now = 2500
		recorder.write("\x1b[3;7H❄️ 界\x1b[K")
		await recorder.close()
		const [recording] = await readRecordings(directory, "session-a")
		const [header, ...events] = cast(recording)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(header).toMatchObject({ version: 3, term: { cols: 120, rows: 40 } })
		expect(events.slice(0, 3)).toEqual([
			[0.12, "o", "\x1b[2J\x1b[Hvisible defect: duplicated row\r\n"],
			[2, "r", "80x24"],
			[0.38, "o", "\x1b[3;7H❄️ 界\x1b[K"],
		])
		expect(recording.metadata.status).toBe("complete")
		expect(await readRecordings(directory, "other-session")).toEqual([])
		expect((await stat(recorder.directory)).mode & 0o777).toBe(0o700)
	})

	it("keeps a playable prefix and records the reason when a size cap is hit", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "capped",
			cols: 80,
			rows: 24,
			limits: { rawBytes: 512 },
		})
		recorder.write("first frame")
		recorder.write("X".repeat(1000))
		recorder.write("must not appear")
		await recorder.close()
		const [recording] = await readRecordings(directory, "capped")
		expect(cast(recording)).toContain("first frame")
		expect(cast(recording)).not.toContain("must not appear")
		expect(recording.metadata.status).toBe("size-limit")
		expect(recording.metadata.rawBytes).toBeLessThanOrEqual(512)
	})

	it("stops on queue pressure instead of retaining unbounded output", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "busy",
			cols: 80,
			rows: 24,
			limits: { queuedBytes: 1024 },
		})
		for (let i = 0; i < 100; i++) recorder.write("redraw ".repeat(70))
		await recorder.close()
		const [recording] = await readRecordings(directory, "busy")
		expect(recording.metadata.status).toBe("queue-limit")
		expect(recording.metadata.queueHighWaterBytes).toBeLessThanOrEqual(1024)
	})

	it("bounds retained visits and replaces only an inactive slot", async () => {
		const directory = await root()
		const options = { root: directory, cols: 80, rows: 24, limits: { slots: 1 } }
		const first = await TerminalRecorder.create({ ...options, sessionId: "first" })
		first.write("old")
		await first.flush()
		await expect(TerminalRecorder.create({ ...options, sessionId: "second" })).rejects.toThrow("in use")
		await first.close()
		const second = await TerminalRecorder.create({ ...options, sessionId: "second" })
		second.write("new")
		await second.close()
		expect(await readRecordings(directory, "first")).toEqual([])
		expect(cast((await readRecordings(directory, "second"))[0])).toContain("new")
		expect((await readdir(directory)).filter((name) => name.startsWith("slot-"))).toHaveLength(1)
	})

	it("keeps the TUI write path usable after a storage failure", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "failed", cols: 80, rows: 24 })
		await rm(recorder.directory, { recursive: true })
		expect(() => recorder.write("output still works")).not.toThrow()
		await expect(recorder.flush()).resolves.toBeUndefined()
		expect(recorder.metadata.status).toBe("storage-error")
		await recorder.close()
	})
})
