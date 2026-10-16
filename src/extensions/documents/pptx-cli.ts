/**
 * `pptx.mjs` — the command-line entry the bundled pptx skill drives. It runs
 * under the kimchi binary's embedded Bun runtime (`BUN_BE_BUN=1 kimchi
 * pptx.mjs ...`) and under plain node, with no Python and no LibreOffice.
 *
 *   pptx.mjs read <deck> [start-end]   Slides as Markdown (≤20 per call) with
 *                                      [shape "..."]/[table] locators; a
 *                                      continuation hint when capped.
 *   pptx.mjs inspect <deck>            Layouts, placeholders and exact shape
 *                                      names — the vocabulary `edit` accepts.
 *   pptx.mjs check <deck>              Static defects (see pptx-check.ts).
 *
 *   pptx.mjs create <out> --content <file.md> [--theme f.json] [--template deck]
 *                                      Build a deck from deck Markdown (see
 *                                      deck-markdown.md for the format).
 *
 * edit lands in its own commit; the dispatcher already knows it so the
 * skill's documentation stays accurate.
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractPptx } from "./extractors/pptx.js"
import { MAX_UNITS_PER_CALL, maxFileBytes } from "./limits.js"
import { DocumentError, isDocumentError } from "./model.js"
import { checkPptx, renderFindings } from "./pptx-check.js"
import { inspectPptx, renderInspection } from "./pptx-inspect.js"
import { renderDocument } from "./render.js"
import { parseDeckMarkdown, writePptx } from "./writers/pptx.js"
import type { DeckTheme } from "./writers/pptx-model.js"
import { createFromTemplate } from "./writers/template.js"

export interface CliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	/** Write overrides let tests intercept outputs; default is atomic temp+rename. */
	writeFile?: (path: string, data: Uint8Array) => void
}

const USAGE = `usage: pptx.mjs <command> [args]

commands:
  read <deck.pptx> [start-end]                    slides as Markdown (20 per call)
  inspect <deck.pptx>                             layouts, placeholders, shape names
  check <deck.pptx>                               likely defects (overflow, alt text, off-slide)
  create <out.pptx> --content <file.md> [--theme <f.json>] [--template <deck.pptx>]
  edit <in.pptx> --out <out.pptx> --ops <file>    (lands in a later commit)`

function readBytes(io: Required<CliIo>["readFile"], path: string): Uint8Array {
	try {
		return io(path)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot read ${path}: ${(err as Error).message}`)
	}
}

function enforceSizeCap(path: string, data: Uint8Array): void {
	const cap = maxFileBytes()
	if (data.length > cap) {
		throw new DocumentError(
			"too-large",
			`${path} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with KIMCHI_DOCUMENT_MAX_MB.`,
			"pptx",
		)
	}
}

function parseSlideRange(arg: string | undefined): { start: number; end: number } | undefined {
	if (!arg) return undefined
	const match = /^(\d+)-(\d+)$/.exec(arg) ?? /^(\d+)$/.exec(arg)
	if (!match) throw new DocumentError("corrupt", `Invalid slide range "${arg}" — use N or N-M (1-based).`)
	const start = Number(match[1])
	const end = match[2] !== undefined ? Number(match[2]) : start
	if (start < 1 || end < start)
		throw new DocumentError("corrupt", `Invalid slide range "${arg}" — start must be ≥1 and end ≥ start.`)
	return { start, end }
}

/** Window indices honoring the 20-slides-per-call cap (1-based, inclusive). */
function windowIndices(totalSlides: number, range?: { start: number; end: number }): number[] {
	const start = range?.start ?? 1
	const end = Math.min(range?.end ?? totalSlides, start + MAX_UNITS_PER_CALL - 1, totalSlides)
	const indices: number[] = []
	for (let i = start; i <= end; i++) indices.push(i)
	return indices
}

export async function runPptxCli(argv: string[], io: CliIo): Promise<number> {
	const readFile = io.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
	const [command, ...args] = argv
	try {
		switch (command) {
			case "read": {
				const [path, rangeArg] = args
				if (!path) throw new DocumentError("corrupt", "read needs a deck path: pptx.mjs read <deck.pptx> [start-end]")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const doc = await extractPptx(data)
				const indices = windowIndices(doc.units.length, parseSlideRange(rangeArg))
				const rendered = renderDocument(doc, { unitIndices: indices, toolName: "pptx.mjs read", path })
				io.stdout(rendered.text)
				if (rendered.selectedUnits < rendered.totalUnits) {
					const nextStart = indices[indices.length - 1] + 1
					io.stderr(
						`showing slides ${indices[0]}-${indices[indices.length - 1]} of ${rendered.totalUnits}; continue with: read ${path} ${nextStart}-${rendered.totalUnits}`,
					)
				}
				return 0
			}
			case "inspect": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "inspect needs a deck path: pptx.mjs inspect <deck.pptx>")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				io.stdout(renderInspection(await inspectPptx(data)))
				return 0
			}
			case "check": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "check needs a deck path: pptx.mjs check <deck.pptx>")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				io.stdout(renderFindings(await checkPptx(data)))
				return 0
			}
			case "create": {
				const [out, ...flags] = args
				if (!out)
					throw new DocumentError(
						"corrupt",
						"create needs an output path: pptx.mjs create <out.pptx> --content <file.md>",
					)
				if (!out.toLowerCase().endsWith(".pptx"))
					throw new DocumentError("corrupt", `output path must end in .pptx: ${out}`)
				const flag = (name: string) => {
					const i = flags.indexOf(name)
					return i >= 0 ? flags[i + 1] : undefined
				}
				const contentPath = flag("--content")
				if (!contentPath)
					throw new DocumentError("corrupt", "create needs --content <file.md> (deck Markdown, see deck-markdown.md)")
				const content = new TextDecoder().decode(readBytes(readFile, contentPath))
				const themePath = flag("--theme")
				let theme: DeckTheme = {}
				if (themePath) {
					const raw = new TextDecoder().decode(readBytes(readFile, themePath))
					let parsed: Record<string, unknown>
					try {
						parsed = JSON.parse(raw) as Record<string, unknown>
					} catch {
						throw new DocumentError("corrupt", `theme file is not valid JSON: ${themePath}`)
					}
					theme = {
						font: typeof parsed.font === "string" ? parsed.font : undefined,
						accent: typeof parsed.accent === "string" ? parsed.accent : undefined,
						slideWidth: typeof parsed.slideWidth === "number" ? parsed.slideWidth : undefined,
						slideHeight: typeof parsed.slideHeight === "number" ? parsed.slideHeight : undefined,
					}
				}
				const spec = parseDeckMarkdown(content, theme)
				const templatePath = flag("--template")
				let bytes: Uint8Array
				if (templatePath) {
					if (theme.font || theme.accent || theme.slideWidth || theme.slideHeight) {
						io.stderr("note: --theme fields are ignored in --template mode; the template's theme wins.")
					}
					const templateData = readBytes(readFile, templatePath)
					enforceSizeCap(templatePath, templateData)
					bytes = await createFromTemplate(spec, templateData)
				} else {
					bytes = await writePptx(spec, { baseDir: dirname(resolve(contentPath)) })
				}
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				io.stdout(`created ${out} (${spec.slides.length} slide${spec.slides.length === 1 ? "" : "s"})`)
				return 0
			}
			case "edit":
				io.stderr("edit is not in this build yet — it lands in a later commit.")
				return 2
			case undefined:
			case "--help":
			case "-h":
				io.stdout(USAGE)
				return command === undefined ? 2 : 0
			default:
				io.stderr(`unknown command "${command}"\n\n${USAGE}`)
				return 2
		}
	} catch (err) {
		if (isDocumentError(err)) {
			io.stderr(`error [${err.code}]: ${err.message}`)
			return 2
		}
		throw err
	}
}

/** Write via temp + rename so an interrupted create never leaves a half file. */
function atomicWrite(path: string, data: Uint8Array): void {
	const temp = `${path}.pptx-mjs-tmp`
	try {
		writeFileSync(temp, data)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot write ${path}: ${(err as Error).message}`)
	}
	renameSync(temp, path)
}

const invokedAsScript = (() => {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === fileURLToPath(import.meta.url)
	} catch {
		return false
	}
})()

if (invokedAsScript) {
	runPptxCli(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	}).then((code) => {
		process.exitCode = code
	})
}
