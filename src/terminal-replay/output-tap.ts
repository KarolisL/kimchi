import { StringDecoder } from "node:string_decoder"

/** Observe all process writes, including cursor/mode methods that bypass Terminal.write(). */
export function tapTerminalOutput(
	streams: NodeJS.WriteStream[],
	onOutput: (text: string) => void,
	onResize: (cols: number, rows: number) => void,
): () => void {
	const restore: (() => void)[] = []
	for (const stream of streams) {
		if (!stream.isTTY) continue
		const original = stream.write
		const decoder = new StringDecoder("utf8")
		const write: typeof stream.write = (chunk, encoding?, callback?) => {
			const bytes =
				typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk
			onOutput(decoder.write(bytes))
			// Preserve overload arguments, callback, receiver and backpressure exactly.
			return original.apply(stream, [chunk, encoding, callback] as Parameters<typeof original>)
		}
		stream.write = write
		restore.push(() => {
			if (stream.write === write) stream.write = original
			const tail = decoder.end()
			if (tail) onOutput(tail)
		})
	}
	const stdout = streams[0]
	const resize = () => onResize(stdout.columns || 80, stdout.rows || 24)
	// Register before the renderer so geometry precedes the resulting repaint.
	stdout.prependListener("resize", resize)
	return () => {
		stdout.off("resize", resize)
		for (const undo of restore) undo()
	}
}
