import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { tapTerminalOutput } from "./output-tap.js"

function terminal(isTTY = true): NodeJS.WriteStream {
	return Object.assign(new PassThrough(), { isTTY, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
}

describe("terminal output tap", () => {
	it("captures stdout, direct cursor writes, stderr and split UTF-8 without changing callbacks", async () => {
		const stdout = terminal()
		const stderr = terminal()
		const original = stdout.write
		const output: string[] = []
		const callback = vi.fn()
		const stop = tapTerminalOutput(
			[stdout, stderr],
			(text) => output.push(text),
			() => {},
		)
		stdout.write("\x1b[?25l")
		const bytes = Buffer.from("界")
		stdout.write(bytes.subarray(0, 1))
		stdout.write(bytes.subarray(1), callback)
		stderr.write("diagnostic")
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(callback).toHaveBeenCalledOnce()
		expect(output.join("")).toBe("\x1b[?25l界diagnostic")
		stop()
		expect(stdout.write).toBe(original)
		stdout.write("after recording")
		expect(output.join("")).not.toContain("after recording")
	})

	it("records resize before repaint and excludes redirected stderr", () => {
		const stdout = terminal()
		const stderr = terminal(false)
		const events: string[] = []
		stdout.on("resize", () => stdout.write("repaint"))
		const stop = tapTerminalOutput(
			[stdout, stderr],
			(text) => events.push(text),
			(cols, rows) => events.push(`${cols}x${rows}`),
		)
		stdout.columns = 120
		stdout.rows = 40
		stdout.emit("resize")
		stderr.write("not on screen")
		expect(events).toEqual(["120x40", "repaint"])
		stop()
	})
})
