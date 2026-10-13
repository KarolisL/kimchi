function unfinishedEscape(text: string): string {
	const start = text.lastIndexOf("\x1b")
	if (start < 0) return ""
	const tail = text.slice(start)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI cancellation and string terminator bytes.
	if (/[\x18\x1a\x9c]/.test(tail)) return ""
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI string sequence introducers.
	if (/^\x1b[\]P_X^]/.test(tail)) {
		return tail[1] === "]" && tail.includes("\x07") ? "" : tail
	}
	// Other C0 controls execute immediately and must not execute again in the next part.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberately match terminal control bytes.
	const sequence = tail.replace(/[\x00-\x1a\x1c-\x1f\x7f]/g, "")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: An incomplete ANSI escape sequence.
	return /^\x1b(?:\[[0-?]*[ -/]*|[ -/]*)$/.test(sequence) ? sequence : ""
}

/** Reconstruct only at a part boundary; ordinary capture never runs a second terminal. */
export async function recordingCheckpoint(chunks: AsyncIterable<Buffer>, cols: number, rows: number) {
	const [{ Terminal }, { SerializeAddon }] = await Promise.all([
		import("@xterm/headless"),
		import("@xterm/addon-serialize"),
	])
	const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
	const serializer = new SerializeAddon()
	terminal.loadAddon(serializer)
	let cursorVisible = true
	let pending = ""
	for (const final of ["h", "l"]) {
		terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
			if (params.flat().includes(25)) cursorVisible = final === "h"
			return false
		})
	}
	const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
	try {
		for await (const chunk of chunks) {
			let output = ""
			for (const line of chunk.toString("utf8").trimEnd().split("\n")) {
				const event = JSON.parse(line)
				if (!Array.isArray(event)) continue
				if (event[1] === "o") {
					output += event[2]
					pending = unfinishedEscape(pending + event[2])
				} else if (event[1] === "r") {
					if (output) await write(output)
					output = ""
					const [width, height] = event[2].split("x").map(Number)
					terminal.resize(width, height)
				}
			}
			if (output) await write(output)
		}
		return {
			data: `${serializer.serialize({ scrollback: 0 })}\x1b[?25${cursorVisible ? "h" : "l"}${pending}`,
			cols: terminal.cols,
			rows: terminal.rows,
		}
	} finally {
		terminal.dispose()
	}
}
