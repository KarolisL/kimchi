import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isHomebrewInstall } from "../update/paths.js"
import { loadAutoUpdateNoticeShown, loadAutoUpdateSetting, markAutoUpdateNoticeShown } from "../update/settings.js"
import { isUpdateCheckDisabled, isUpdateNoticeEnabled } from "../update/state.js"
import { checkForUpdate, parseCanarySha7 } from "../update/workflow.js"
import { getVersion } from "../utils.js"

const UPDATE_STATUS_KEY = "update-available"

/** Force exactly one leading "v" onto a version-like string: "1.16.0" and
 *  "v1.16.0" both render as "v1.16.0", never "vv…". Non-semver build strings
 *  (dev, unknown) pass through untouched. */
function withVPrefix(version: string): string {
	return /^\d/.test(version) ? `v${version}` : version
}

/** One-line notice for host-pinned installs (KIMCHI_UPDATE_NOTICE). Deliberately
 *  does not suggest `kimchi update` — the host app manages this copy. */
function updateNoticeText(latestVersion: string, currentVersion: string): string {
	return `A new Kimchi version is available: ${withVPrefix(latestVersion)} (current ${withVPrefix(currentVersion)}).`
}

/**
 * Startup-time check for new kimchi versions. Uses cache (24h) and displays
 * a message on the status line (right side, centered) if an update is available.
 * Silently fails on errors to not block harness launch.
 *
 * The message is displayed via setStatus and read by the status line renderer.
 *
 * When auto-update is enabled (opt-in default — the toggle defaults to
 * off, so most users land here), the footer hint is suppressed — users
 * get updates silently on next launch. The first launch after a user
 * enables the toggle also emits a one-time onboarding toast explaining
 * the behavior and how to opt out via `/update`.
 */
export default function startupUpdateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return

		const current = getVersion()
		// Canary users opted into the canary track; don't nag them about
		// stable. Currency on canary is checked by `kimchi update --canary`.
		if (parseCanarySha7(current) !== null) return

		// Notice-only path for host apps that pin the binary: KIMCHI_NO_UPDATE_CHECK
		// keeps the self-updater off, but the host opts into telling the user a
		// newer stable exists (KIMCHI_UPDATE_NOTICE). Read-only check — never a
		// download or install. TUI only: the host may talk to us over ACP, and
		// the notice must never leak into protocol output.
		if (isUpdateNoticeEnabled() && isUpdateCheckDisabled()) {
			if (ctx.mode !== "tui") return
			try {
				const result = await checkForUpdate({
					currentVersion: current,
					skipCache: false,
					ignoreUpdateCheckDisabled: true,
				})
				if (result.hasUpdate) {
					ctx.ui.notify(updateNoticeText(result.latestVersion, result.currentVersion), "info")
				}
			} catch {
				// Silently ignore errors - don't block harness launch
			}
			return
		}

		try {
			const autoUpdateEnabled = loadAutoUpdateSetting()
			// Only suppress the footer nag when on-launch auto-update can
			// actually run. Homebrew installs are skipped by the launch
			// auto-update path (see auto-update.ts), so a Homebrew user with
			// autoUpdate=true would otherwise get neither a background update
			// nor the `brew upgrade kimchi` hint.
			if (autoUpdateEnabled && !isHomebrewInstall()) {
				// Auto-update is on: no nag (next launch applies silently).
				// First launch only: explain the new behavior and how to opt out.
				if (!loadAutoUpdateNoticeShown()) {
					ctx.ui.notify("kimchi now updates itself in the background. Run `/update` to disable.")
					markAutoUpdateNoticeShown()
				}
				return
			}
		} catch (err) {
			// Settings layer broken (e.g. getAgentDir() throws, disk
			// unwritable). Don't crash the session — bail and let the
			// rest of the harness boot normally. Mirrors the swallow-
			// and-continue pattern used for checkForUpdate below, but
			// also returns early because we have no signal worth
			// showing when the settings file itself is unreadable.
			console.warn(`[startup-update] auto-update settings unavailable: ${(err as Error).message}`)
			return
		}

		try {
			const result = await checkForUpdate({ currentVersion: current, skipCache: false })
			if (result.hasUpdate) {
				// Homebrew-managed installs live outside kimchi's swap path —
				// point the user at `brew upgrade` rather than `kimchi update`.
				const updateCmd = ctx.ui.theme.bold(isHomebrewInstall() ? "brew upgrade kimchi" : "kimchi update")
				ctx.ui.setStatus(UPDATE_STATUS_KEY, `Update available! Run ${updateCmd}`)
			}
		} catch {
			// Silently ignore errors - don't block harness launch
		}
	})
}
