import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"
import { appendBeforeBody } from "../utils/export-post-process.js"
import type { Recording } from "./recorder.js"

const compress = promisify(gzip)

function assetsDirectory(): string {
	const staged = join(resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath), "terminal-replay")
	return existsSync(staged) ? staged : fileURLToPath(new URL("../../resources/terminal-replay/", import.meta.url))
}

export async function addTerminalReplay(html: string, recordings: Recording[]): Promise<string> {
	if (recordings.length === 0) {
		return appendBeforeBody(
			html,
			'<p id="terminal-replay-unavailable" style="position:fixed;bottom:12px;right:20px;background:#222;color:#ddd;padding:8px;z-index:1100">Terminal replay unavailable: recording was disabled, expired, or could not be saved.</p>',
		)
	}
	const assets = assetsDirectory()
	const [template, js, css, license, vtLicense] = await Promise.all(
		["player.html", "asciinema-player.min.js", "asciinema-player.css", "LICENSE", "VT-LICENSE-MIT"].map((file) =>
			readFile(join(assets, file), "utf8"),
		),
	)
	const payloads: { metadata: Recording["metadata"]; gzip: string }[] = []
	for (const recording of recordings) {
		payloads.push({ metadata: recording.metadata, gzip: (await compress(recording.cast)).toString("base64") })
	}
	const document = template
		.replace("/* PLAYER_JS */", () => js.replace(/<\/script/gi, "<\\/script"))
		.replace("/* PLAYER_CSS */", () => css)
		.replace("/* RECORDINGS */", () => JSON.stringify(payloads).replaceAll("<", "\\u003c"))
		.replace("/* LICENSES */", () => JSON.stringify(`${license}\n\n${vtLicense}`).replaceAll("<", "\\u003c"))
	const encoded = Buffer.from(document).toString("base64")
	return appendBeforeBody(
		html,
		`
<button id="terminal-replay-open" type="button" style="position:fixed;bottom:20px;right:20px;z-index:1100;background:#a3e635;color:#16210b;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;font:600 14px system-ui">▶ Terminal replay</button>
<dialog id="terminal-replay-dialog" style="width:94vw;height:90vh;max-width:1600px;padding:0;border:1px solid #444;border-radius:12px;background:#17191d;color:#eee">
<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #333;font:600 16px system-ui"><span>Terminal replay</span><button id="terminal-replay-close" type="button" style="background:#333;color:#eee;border:0;border-radius:5px;padding:7px 12px;cursor:pointer">Back to transcript</button></div>
<iframe id="terminal-replay-frame" title="Terminal recording" sandbox="allow-scripts" style="width:100%;height:calc(100% - 60px);border:0"></iframe>
</dialog>
<script id="terminal-replay-document" type="application/octet-stream">${encoded}</script>
<script id="terminal-replay-launcher">
(() => {
  const dialog = document.getElementById('terminal-replay-dialog');
  const frame = document.getElementById('terminal-replay-frame');
  document.getElementById('terminal-replay-open').onclick = () => {
    dialog.showModal();
    const bytes = Uint8Array.from(atob(document.getElementById('terminal-replay-document').textContent.trim()), c => c.charCodeAt(0));
    frame.srcdoc = new TextDecoder().decode(bytes);
  };
  document.getElementById('terminal-replay-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { frame.srcdoc = ''; });
})();
</script>`,
	)
}

export async function appendTerminalReplayExport(path: string, recordings: Recording[]): Promise<void> {
	const html = await readFile(path, "utf8")
	await writeFile(path, await addTerminalReplay(html, recordings), "utf8")
}
