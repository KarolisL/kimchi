import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"
import { appendBeforeBody } from "../utils/export-post-process.js"
import { enrichReplayDetails } from "./details.js"
import type { Recording } from "./recorder.js"

function assetsDirectory(): string {
	const staged = join(resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath), "terminal-replay")
	return existsSync(staged)
		? staged
		: fileURLToPath(new URL("../../resources/terminal-replay/generated/", import.meta.url))
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
	const enrichedRecordings = await enrichReplayDetails(html, recordings)
	const document = template
		.replace("/* PLAYER_JS */", () => js.replace(/<\/script/gi, "<\\/script"))
		.replace("/* PLAYER_CSS */", () => css)
		.replace("/* RECORDINGS */", () => JSON.stringify(enrichedRecordings).replaceAll("<", "\\u003c"))
		.replace("/* LICENSES */", () => JSON.stringify(`${license}\n\n${vtLicense}`).replaceAll("<", "\\u003c"))
	const encoded = Buffer.from(document).toString("base64")
	return appendBeforeBody(
		html,
		`
<style id="terminal-replay-style">
  #terminal-replay-toolbar { position:sticky;top:0;z-index:1000;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;background:#191b1f;border-bottom:1px solid #303137;color:#eeece9;font:14px system-ui,sans-serif; }
  #terminal-replay-toolbar strong { font-size:13px;font-weight:600;letter-spacing:.1px; }
  #terminal-replay-toolbar [role="group"] { display:flex;gap:4px;padding:3px;background:#121316;border:1px solid #303137;border-radius:8px; }
  #terminal-replay-toolbar button { padding:7px 14px;border:0;border-radius:5px;background:transparent;color:#aab1bd;cursor:pointer;font:500 13px system-ui,sans-serif; }
  #terminal-replay-toolbar button[aria-pressed="true"] { background:#392c26;color:#f3bb9e;box-shadow:inset 0 0 0 1px #5a4235; }
  #terminal-replay-toolbar button:hover { color:#fff; }
  #terminal-replay-toolbar button:focus-visible { outline:2px solid #efaa86;outline-offset:2px; }
  body.terminal-replay-inline:not(.terminal-replay-active) #terminal-replay-toolbar { display:none; }
  body.terminal-replay-inline:not(.terminal-replay-active) #hamburger { top:12px; }
  #terminal-replay-panel { display:none;position:fixed;inset:var(--terminal-replay-header-h,62px) 0 0;z-index:999;background:#111215; }
  #terminal-replay-frame { display:block;width:100%;height:100%;border:0; }
  body.terminal-replay-active { overflow:hidden; }
  body.terminal-replay-active #app, body.terminal-replay-active #hamburger, body.terminal-replay-active #sidebar-overlay, body.terminal-replay-active #subagent-tabs, body.terminal-replay-active > iframe { display:none !important; }
  body.terminal-replay-active #terminal-replay-panel { display:block; }
  #sidebar, #sidebar-resizer { top:var(--terminal-replay-header-h,62px);height:calc(100vh - var(--terminal-replay-header-h,62px)); }
  #sidebar-overlay { top:var(--terminal-replay-header-h,62px); }
  #hamburger { top:15px;left:12px;z-index:1001; }
  @media (max-width:900px) { body:not(.terminal-replay-active) #terminal-replay-toolbar strong { margin-left:40px; } }
  @media (max-width:600px) { #terminal-replay-toolbar { padding:8px 12px;gap:8px; } }
  @media print { #terminal-replay-toolbar, #terminal-replay-panel { display:none !important; } body.terminal-replay-active #app { display:flex !important; } }
</style>
<nav id="terminal-replay-toolbar" aria-label="Session views">
  <strong>Session</strong>
  <div role="group" aria-label="View">
    <button id="terminal-replay-close" type="button" aria-pressed="true">Transcript</button>
    <button id="terminal-replay-open" type="button" aria-pressed="false" aria-controls="terminal-replay-panel">Replay</button>
  </div>
</nav>
<section id="terminal-replay-panel" aria-label="Terminal replay">
  <iframe id="terminal-replay-frame" title="Terminal recording" sandbox="allow-scripts allow-downloads"></iframe>
</section>
<script id="terminal-replay-document" type="application/octet-stream">${encoded}</script>
<script id="terminal-replay-launcher">
(() => {
  const toolbar = document.getElementById('terminal-replay-toolbar');
  const frame = document.getElementById('terminal-replay-frame');
  const replay = document.getElementById('terminal-replay-open');
  const transcript = document.getElementById('terminal-replay-close');
  const sessionHeader = document.getElementById('sa-header');
  (sessionHeader || document.body).prepend(toolbar);
  new ResizeObserver(() => {
    const height = (sessionHeader || toolbar).getBoundingClientRect().height + 'px';
    document.documentElement.style.setProperty('--terminal-replay-header-h', height);
    if (sessionHeader) document.documentElement.style.setProperty('--sa-header-h', height);
  }).observe(sessionHeader || toolbar);
  function placeActions() {
    const actions = document.querySelector('#header-container .help-actions');
    if (!actions || replay.parentElement === actions) return;
    replay.className = 'download-json-btn';
    replay.textContent = '▶ Replay';
    actions.append(replay);
    document.body.classList.add('terminal-replay-inline');
  }
  placeActions();
  const header = document.getElementById('header-container');
  if (header) new MutationObserver(placeActions).observe(header, { childList:true, subtree:true });
  let active = false;
  let scrollPositions = [];
  function showReplay(show) {
    if (show === active) return;
    if (show) {
      scrollPositions = [document.scrollingElement, document.getElementById('sa-body'), document.getElementById('content')]
        .filter(Boolean).map(element => [element, element.scrollTop]);
    }
    active = show;
    document.body.classList.toggle('terminal-replay-active', show);
    replay.setAttribute('aria-pressed', String(show));
    transcript.setAttribute('aria-pressed', String(!show));
    if (show && !frame.hasAttribute('srcdoc')) {
      const bytes = Uint8Array.from(atob(document.getElementById('terminal-replay-document').textContent.trim()), c => c.charCodeAt(0));
      frame.srcdoc = new TextDecoder().decode(bytes);
    }
    if (!show) {
      frame.contentWindow?.postMessage('kimchi-replay-pause', '*');
      for (const [element, top] of scrollPositions) element.scrollTop = top;
      replay.focus({ preventScroll:true });
    }
  }
  replay.onclick = () => showReplay(true);
  transcript.onclick = () => showReplay(false);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) showReplay(false);
  });
})();
</script>`,
	)
}

export async function appendTerminalReplayExport(path: string, recordings: Recording[]): Promise<void> {
	const html = await readFile(path, "utf8")
	await writeFile(path, await addTerminalReplay(html, recordings), "utf8")
}
