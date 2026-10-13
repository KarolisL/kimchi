import { join } from "node:path"
import { type ExtensionAPI, type ExtensionContext, getAgentDir, InteractiveMode } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../cli-args.js"
import { readConfigSetting } from "../config/settings.js"
import { tapTerminalOutput } from "./output-tap.js"
import { type Recording, readRecordings, recordingDeadline, TerminalRecorder } from "./recorder.js"

let active: TerminalRecorder | undefined
let untap: (() => void) | undefined
let installed = false
const exportConsent = new Map<string, () => Promise<boolean>>()
const recordingRoot = () => join(getAgentDir(), "terminal-recordings")

function enabled(): boolean {
	return (
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true &&
		!getParsedCliArgs().options["no-session"] &&
		readConfigSetting("terminalRecording", (value): value is boolean => typeof value === "boolean", true)
	)
}

async function begin(manager: ExtensionContext["sessionManager"]): Promise<boolean> {
	if (!enabled()) {
		await finish()
		return false
	}
	if (active?.metadata.sessionId === manager.getSessionId()) return false
	await finish()
	try {
		const pending = TerminalRecorder.create({
			root: recordingRoot(),
			sessionId: manager.getSessionId(),
			cols: process.stdout.columns || 80,
			rows: process.stdout.rows || 24,
		})
		active = await recordingDeadline(pending)
		if (!active) {
			void pending.then((recorder) => recorder.close()).catch(() => {})
			return false
		}
		const recorder = active
		untap = tapTerminalOutput(
			[process.stdout, process.stderr],
			(data) => recorder.write(data),
			(cols, rows) => recorder.resize(cols, rows),
		)
		return true
	} catch {
		// Failure to record must not prevent opening a session. Export explains missing coverage.
		return false
	}
}

async function finish(): Promise<void> {
	untap?.()
	untap = undefined
	const previous = active
	active = undefined
	if (previous) await recordingDeadline(previous.close())
}

interface ReplayInteractiveMode {
	sessionManager: ExtensionContext["sessionManager"]
	ui: { requestRender(force?: boolean): void }
	init(): Promise<void>
	rebindCurrentSession(options?: { renderBeforeBind?: boolean }): Promise<void>
}

/** Pi starts its terminal before session_start. This adapter captures that first frame too. */
export function installTerminalRecording(): void {
	if (installed) return
	installed = true
	// Private upstream boundary, intentionally confined to this adapter and pinned by a TUI e2e.
	const prototype = InteractiveMode.prototype as unknown as ReplayInteractiveMode
	const init = prototype.init
	prototype.init = async function () {
		await begin(this.sessionManager)
		return init.call(this)
	}
	const rebind = prototype.rebindCurrentSession
	prototype.rebindCurrentSession = async function (options) {
		const changed = await begin(this.sessionManager)
		// A session visit needs a full initial frame; differential output alone is not replayable.
		if (changed) this.ui.requestRender(true)
		return rebind.call(this, options)
	}
}

export function terminalRecordingExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId()
		exportConsent.set(id, async () => {
			const include = "Transcript + replay (raw terminal output)"
			return (
				(await ctx.ui.select(
					"Include terminal replay? It can contain secrets, drafts and cleared output. Only the transcript is redacted.",
					["Transcript only (redacted)", include],
				)) === include
			)
		})
	})
	pi.on("session_shutdown", async (event, ctx) => {
		exportConsent.delete(ctx.sessionManager.getSessionId())
		if (event.reason !== "quit") return
		await finish()
	})
}

/** Raw terminal content is never silently added to an otherwise redacted export. */
export async function recordingsForExport(sessionId: string): Promise<Recording[] | undefined> {
	const consent = exportConsent.get(sessionId)
	if (!consent) return undefined
	if (active?.metadata.sessionId === sessionId) await recordingDeadline(active.flush())
	const recordings = (await recordingDeadline(readRecordings(recordingRoot(), sessionId), 3000)) ?? []
	if (recordings.length === 0) return []
	return (await consent()) ? recordings : undefined
}
