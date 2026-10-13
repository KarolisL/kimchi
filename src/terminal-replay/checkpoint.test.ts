import { Terminal } from "@xterm/headless"
import { describe, expect, it } from "vitest"
import { recordingCheckpoint } from "./checkpoint.js"

async function screen(data: string) {
	const terminal = new Terminal({ cols: 20, rows: 6, allowProposedApi: true, scrollback: 0 })
	let visible = true
	for (const final of ["h", "l"]) {
		terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
			if (params.flat().includes(25)) visible = final === "h"
			return false
		})
	}
	try {
		await new Promise<void>((resolve) => terminal.write(data, resolve))
		const buffer = terminal.buffer.active
		return {
			rows: Array.from({ length: 6 }, (_, row) =>
				Array.from({ length: 20 }, (_, col) => {
					const cell = buffer.getLine(buffer.baseY + row)?.getCell(col)
					return [cell?.getChars(), cell?.getFgColor(), cell?.getBgColor(), cell?.getWidth()]
				}),
			),
			cursor: [buffer.cursorX, buffer.cursorY, visible],
			buffer: buffer.type,
		}
	} finally {
		terminal.dispose()
	}
}

describe("recording checkpoints", () => {
	it.each([
		["colours, wide characters and cursor", "\x1b[2;3H\x1b[38;2;255;0;0m界RED", " NEXT"],
		["alternate screen and hidden cursor", "\x1b[?1049h\x1b[?25l\x1b[2;1HDUPLICATE\x1b[3;1HDUPLICATE", "!"],
		["split colour sequence", "before\x1b[38;2;255;", "0;0mAFTER"],
		["split window title", "before\x1b]0;unfinished ", "title\x07AFTER"],
	])("preserves %s across parts", async (_name, before, after) => {
		async function* chunks() {
			yield Buffer.from(`${JSON.stringify([0, "o", before])}\n`)
		}
		const checkpoint = await recordingCheckpoint(chunks(), 20, 6)
		expect(await screen(checkpoint.data + after)).toEqual(await screen(before + after))
	})
})
