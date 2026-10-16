import { describe, expect, it } from "vitest"
import { makeDefectivePptx, makeSimplePptx } from "./fixtures/builders.js"
import { runPptxCli } from "./pptx-cli.js"

function io() {
	const out: string[] = []
	const err: string[] = []
	const files = new Map<string, Uint8Array>()
	return {
		out,
		err,
		files,
		io: {
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
			readFile: (path: string) => {
				const data = files.get(path)
				if (!data) throw new Error(`ENOENT: ${path}`)
				return data
			},
		},
	}
}

describe("pptx.mjs read", () => {
	it("renders the extractor's markdown through the shared renderer (one renderer, two callers)", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		expect(await runPptxCli(["read", "deck.pptx"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain("## Slide 1")
		expect(t.out.join("\n")).toContain('[shape "Title 1"]')
		expect(t.out.join("\n")).toContain("| H1 | H2 |")
		expect(t.out.join("\n")).toContain("Remember to thank sponsors")
		expect(t.out.join("\n")).toContain("*hidden slide*")
	})

	it("honors explicit slide ranges", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		expect(await runPptxCli(["read", "deck.pptx", "2-2"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain("## Slide 2")
		expect(t.out.join("\n")).toContain("Closing remarks")
		expect(t.out.join("\n")).not.toContain("## Slide 1")
	})

	it("rejects a missing file with a typed error and exit 2", async () => {
		const t = io()
		expect(await runPptxCli(["read", "missing.pptx"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("error [corrupt]: Cannot read missing.pptx")
	})

	it("rejects an over-cap file with typed error too-large", async () => {
		const t = io()
		process.env.KIMCHI_DOCUMENT_MAX_MB = "1"
		try {
			t.files.set("big.pptx", new Uint8Array(1_500_000).fill(0x50))
			expect(await runPptxCli(["read", "big.pptx"], t.io)).toBe(2)
			expect(t.err.join("\n")).toContain("error [too-large]")
		} finally {
			delete process.env.KIMCHI_DOCUMENT_MAX_MB
		}
	})

	it("rejects a corrupt package", async () => {
		const t = io()
		t.files.set("junk.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
		expect(await runPptxCli(["check", "junk.pptx"], t.io)).toBe(2)
		expect(t.err.join("\n")).toMatch(/error \[(corrupt|safety-limit)\]/)
	})
})

describe("pptx.mjs check / inspect", () => {
	it("check prints locator-carrying findings", async () => {
		const t = io()
		t.files.set("defect.pptx", await makeDefectivePptx())
		expect(await runPptxCli(["check", "defect.pptx"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain('slide 1 [shape "Body Overflow"] text-overflow: likely text overflow')
	})

	it("unknown command prints usage to stderr, exit 2", async () => {
		const t = io()
		expect(await runPptxCli(["frobnicate"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain('unknown command "frobnicate"')
	})
})
