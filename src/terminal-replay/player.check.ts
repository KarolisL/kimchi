/** Manual browser regression: REPLAY_BROWSER_CHANNEL=chrome pnpm exec tsx src/terminal-replay/player.check.ts */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright"
import { addTerminalReplay } from "./export.js"
import { readRecordings, TerminalRecorder } from "./recorder.js"

const directory = await mkdtemp(join(tmpdir(), "kimchi-replay-browser-"))
const browser = await chromium.launch({ channel: process.env.REPLAY_BROWSER_CHANNEL })
try {
	let now = 0
	const recorder = await TerminalRecorder.create({
		root: directory,
		sessionId: "visual-defect",
		cols: 80,
		rows: 24,
		now: () => now,
	})
	now = 100
	recorder.write("\x1b[2J\x1b[H\x1b[2;1HDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界")
	now = 2000
	recorder.write("\x1b[3;1H\x1b[2Kcleared later")
	now = 3000
	recorder.resize(40, 12)
	recorder.write("\x1b[2J\x1b[H\x1b[4;39HXYZZ\x1b[?25l")
	now = 5000
	await recorder.close()
	const recordings = await readRecordings(directory, "visual-defect")
	const path = join(directory, "replay.html")
	await writeFile(path, await addTerminalReplay("<html><body>Transcript remains available</body></html>", recordings))
	const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
	const requests: string[] = []
	const errors: string[] = []
	page.on("request", (request) => {
		if (/^https?:/.test(request.url())) requests.push(request.url())
	})
	page.on("pageerror", (error) => errors.push(error.message))
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	const frame = page.frameLocator("#terminal-replay-frame")
	await frame.locator(".ap-term").waitFor()
	async function seek(fraction: number) {
		await frame.locator(".ap-control-bar").hover()
		const bar = frame.locator(".ap-progressbar").first()
		const box = await bar.boundingBox()
		assert(box)
		await bar.click({ position: { x: box.width * fraction, y: box.height / 2 }, force: true })
		await page.waitForTimeout(150)
	}
	const lines = () => frame.locator(".ap-line").allTextContents()
	await seek(0.2)
	let rows = await lines()
	assert.equal(rows.length, 24)
	assert.equal(rows[1].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[2].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[3].indexOf("界"), 6)
	await seek(0.5)
	assert.equal((await lines())[2].trimEnd(), "cleared later")
	await seek(0.7)
	rows = await lines()
	assert.equal(rows.length, 12, "The recorded resize must change the emulator's rows")
	assert.equal(
		await frame.locator(".ap-term").evaluate((element) => element.style.getPropertyValue("--term-cols")),
		"40",
	)
	assert.equal(rows[3].slice(38), "XY")
	assert.equal(rows[4].trimEnd(), "ZZ", "Output must wrap at the recorded width")
	await frame.getByLabel("Playback speed").selectOption("4")
	await page.waitForTimeout(200)
	assert.equal((await lines())[4].trimEnd(), "ZZ", "Speed change must preserve position")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await page.waitForTimeout(100)
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#terminal-replay-dialog").isVisible(), false)
	assert.deepEqual(requests, [], "The standalone export must not request remote content")
	assert.deepEqual(errors, [])
	console.log(
		"PASS: defect, clearing, Unicode placement, resize/wrap, seek, speed, play/pause, transcript return and offline loading",
	)
} finally {
	await browser.close()
	await rm(directory, { recursive: true, force: true })
}
