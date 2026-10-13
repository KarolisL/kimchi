/** Manual browser regression: pnpm exec tsx src/terminal-replay/player.check.ts */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { chromium } from "playwright"
import { postProcessHtmlExport } from "../utils/export-post-process.js"
import { addTerminalReplay } from "./export.js"
import { readRecordings, TerminalRecorder } from "./recorder.js"

const directory = await mkdtemp(join(tmpdir(), "kimchi-replay-browser-"))
const browser = await chromium.launch({
	channel: process.env.REPLAY_BROWSER_CHANNEL,
	headless: process.env.REPLAY_BROWSER_HEADED !== "1",
})
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
	const second = await TerminalRecorder.create({
		root: directory,
		sessionId: "visual-defect",
		cols: 20,
		rows: 6,
		now: () => now,
	})
	now = 5500
	second.write("\x1b[2J\x1b[HSECOND VISIT")
	now = 10000
	await second.close()
	const recordings = await readRecordings(directory, "visual-defect")
	const path = join(directory, "replay.html")
	const transcript = `<!doctype html><html><head><style>body{margin:0}#app{min-height:2400px}</style></head><body><div id="app"><main id="content"><div id="messages">Transcript remains available</div></main></div></body></html>`
	await writeFile(path, await addTerminalReplay(transcript, recordings))
	const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
	const requests: string[] = []
	const errors: string[] = []
	page.on("request", (request) => {
		if (/^https?:/.test(request.url())) requests.push(request.url())
	})
	page.on("pageerror", (error) => errors.push(error.message))
	await page.goto(pathToFileURL(path).href)
	assert.equal(await page.locator("#terminal-replay-close").getAttribute("aria-pressed"), "true")
	await page.evaluate(() => window.scrollTo(0, 900))
	await page.locator("#terminal-replay-open").click()
	assert.equal(await page.locator("#app").isVisible(), false)
	assert.equal(await page.locator("#terminal-replay-open").getAttribute("aria-pressed"), "true")
	const frame = page.frameLocator("#terminal-replay-frame")
	await frame.locator(".ap-term").waitFor()
	assert.doesNotMatch(await frame.locator("body").innerText(), /Player credits|asciinema-player|Marcin Kulik/)
	assert.match((await frame.locator("#licenses").textContent()) ?? "", /Apache License/)
	const details = frame.locator("details")
	assert.equal(await details.locator(".details-body").isVisible(), false)
	await details.locator("summary").click()
	assert.equal(await details.getByText(/Includes visible drafts and cleared text/).isVisible(), true)
	await details.locator("summary").click()
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
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
	await seek(0.2)
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await frame.getByLabel("Playback speed").selectOption("0.5")
	await page.waitForTimeout(200)
	assert.equal(
		await frame.getByRole("button", { name: "Pause", exact: true }).isVisible(),
		true,
		"Changing speed while playing must continue playback",
	)
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await seek(0.7)
	const beforeClose = await lines()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#terminal-replay-panel").isVisible(), false)
	assert.equal(await page.locator("#app").isVisible(), true)
	assert.equal(await page.evaluate(() => window.scrollY), 900, "Returning must preserve transcript scroll")
	await page.locator("#terminal-replay-open").click()
	await frame.locator(".ap-term").waitFor()
	assert.deepEqual(await lines(), beforeClose, "Reopening replay must preserve the recorded screen and position")
	assert.equal(await frame.getByLabel("Playback speed").inputValue(), "0.5")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await page.locator("#terminal-replay-close").focus()
	await page.keyboard.press("Escape")
	await page.waitForTimeout(100)
	const whileClosed = await lines()
	await page.waitForTimeout(300)
	await page.locator("#terminal-replay-open").click()
	assert.deepEqual(await lines(), whileClosed, "Playback must pause while the transcript is visible")
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).isVisible(), true)
	await frame.getByLabel("Recording part").selectOption("1")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.5)
	rows = await lines()
	assert.equal(rows.length, 6)
	assert.equal(rows[0].trimEnd(), "SECOND VISIT", "Switching visits must replace the cached recording")
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.7)
	assert.equal((await lines())[4].trimEnd(), "ZZ")
	assert.equal(await frame.locator(".ap-wrapper").count(), 1, "Only the selected player remains mounted")
	const downloaded = page.waitForEvent("download")
	await frame.getByRole("button", { name: "Download part", exact: true }).click()
	const download = await downloaded
	assert.match(download.suggestedFilename(), /^kimchi-replay-.*-part-1\.html$/)
	const downloadPath = join(directory, download.suggestedFilename())
	await download.saveAs(downloadPath)
	const downloadedHtml = await readFile(downloadPath, "utf8")
	const payload = downloadedHtml.match(/<script id="recordings" type="application\/json">(.*?)<\/script>/s)
	assert(payload)
	assert.deepEqual(JSON.parse(payload[1]), [recordings[0]], "Download must contain only the selected part")
	const offline = await browser.newPage()
	await offline.context().setOffline(true)
	offline.on("pageerror", (error) => errors.push(error.message))
	await offline.goto(pathToFileURL(downloadPath).href)
	await offline.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await offline.getByLabel("Recording part").locator("option").count(), 1)
	assert.match((await offline.locator("#licenses").textContent()) ?? "", /Apache License/)
	await offline.getByRole("button", { name: "Play", exact: true }).click()
	await offline.waitForTimeout(300)
	assert.equal((await offline.locator(".ap-line").allTextContents())[1].trimEnd(), "DUPLICATE BUG")
	await offline.close()
	await page.setViewportSize({ width: 390, height: 844 })
	await page.waitForTimeout(150)
	await details.locator("summary").click()
	const detailsBox = await details.locator(".details-body").boundingBox()
	assert(detailsBox && detailsBox.x >= 0 && detailsBox.x + detailsBox.width <= 390)
	await details.locator("summary").click()
	const controls = await frame.locator(".ap-control-bar").boundingBox()
	assert(controls && controls.x >= 0 && controls.x + controls.width <= 390 && controls.y + controls.height <= 844)
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#app").isVisible(), true)

	const rolling = await TerminalRecorder.create({
		root: join(directory, "rolling"),
		sessionId: "rolling",
		cols: 30,
		rows: 8,
		limits: { slots: 2, rawBytes: 2048 },
		now: () => now,
	})
	rolling.write("\x1b[2J\x1b[H\x1b[2;1H\x1b[31mDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界\x1b[0m")
	rolling.resize(25, 7)
	await rolling.flush()
	for (let index = 0; index < 20; index++) {
		now += 1000
		rolling.write(`\x1b[6;1H\x1b[2K${"\x1b[0m".repeat(30)}update ${index}`)
		await rolling.flush()
	}
	await rolling.close()
	const retained = await readRecordings(join(directory, "rolling"), "rolling")
	assert.equal(retained.length, 2)
	assert((retained[0].metadata.part ?? 1) > 1, "The original part must have been evicted")
	await writeFile(path, await addTerminalReplay(transcript, retained))
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.9)
	rows = await lines()
	assert.equal(rows.length, 7)
	assert.equal(rows[1].trimEnd(), "DUPLICATE BUG", "A later part must retain an earlier visual defect")
	assert.equal(rows[2].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[3].indexOf("界"), 6)
	assert.match(rows[5], /update 1\d/)

	const inlineTranscript = transcript.replace(
		'<div id="messages">',
		'<div id="header-container"><div class="help-actions" style="display:flex;gap:8px"><button class="download-json-btn">↓ JSONL</button></div></div><div id="messages">',
	)
	await writeFile(path, await addTerminalReplay(inlineTranscript, recordings))
	await page.goto(pathToFileURL(path).href)
	assert.equal(await page.locator(".help-actions #terminal-replay-open").count(), 1)
	assert.equal(await page.locator("#terminal-replay-toolbar").isVisible(), false)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator(".help-actions #terminal-replay-open").isVisible(), true)
	assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-replay-open")
	await page.locator("#header-container").evaluate((element) => {
		element.innerHTML = '<div class="help-actions"><button class="download-json-btn">↓ JSONL</button></div>'
	})
	await page.locator(".help-actions #terminal-replay-open").waitFor()
	assert.equal(await page.locator("#terminal-replay-open").count(), 1, "Header rerenders must not duplicate buttons")

	// Exercise the actual subagent clone/switcher with a small export shell.
	const subagentData = Buffer.from(
		JSON.stringify({
			entries: [
				{
					type: "custom",
					customType: "subagents:record",
					data: {
						id: "agent-001",
						type: "Explore",
						status: "completed",
						transcript: [
							{
								isSidechain: true,
								agentId: "agent-001",
								type: "user",
								message: { role: "user", content: "Subagent transcript" },
								timestamp: "2026-10-13T10:00:00Z",
								cwd: directory,
							},
						],
					},
				},
			],
		}),
	).toString("base64")
	await writeFile(
		path,
		transcript.replace("</body>", `<script id="session-data" type="application/json">${subagentData}</script></body>`),
	)
	postProcessHtmlExport(path)
	await writeFile(path, await addTerminalReplay(await readFile(path, "utf8"), recordings))
	await page.goto(pathToFileURL(path).href)
	await page.locator('[data-sa-id="agent-001"]').click()
	const subagent = page.locator("body > iframe")
	await subagent.contentFrame().locator("#app").waitFor()
	assert.equal(await subagent.contentFrame().locator('[id^="terminal-replay-"]').count(), 0)
	await page.locator("#terminal-replay-open").click()
	await frame.locator(".ap-term").waitFor()
	assert.equal(await subagent.isVisible(), false)
	assert.equal(await page.locator("#subagent-tabs").isVisible(), false)
	await page.locator("#terminal-replay-close").click()
	assert.equal(await subagent.isVisible(), true, "Returning must preserve the selected subagent")
	await page.locator('[data-sa-id="main"]').click()
	await page.locator("#sa-body").evaluate((element) => {
		element.scrollTop = 700
	})
	await page.locator("#terminal-replay-open").click()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#sa-body").evaluate((element) => element.scrollTop), 700)
	assert.deepEqual(requests, [], "The standalone export must not request remote content")
	assert.deepEqual(errors, [])
	console.log(
		"PASS: defect, clearing, Unicode, resize/wrap, seek, speed, pause/reopen, mobile controls, retained parts, standalone download playing offline, subagent views and embedded notices",
	)
} finally {
	await browser.close()
	await rm(directory, { recursive: true, force: true })
}
