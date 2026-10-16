import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const checkForUpdateMock = vi.fn()
const getVersionMock = vi.fn()
const isHomebrewInstallMock = vi.fn(() => false)
const loadAutoUpdateSettingMock = vi.fn(() => false)
const loadAutoUpdateNoticeShownMock = vi.fn(() => false)
const markAutoUpdateNoticeShownMock = vi.fn()

vi.mock(import("../update/workflow.js"), async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		checkForUpdate: (...args: unknown[]) => checkForUpdateMock(...args),
	}
})
vi.mock("../utils.js", () => ({
	getVersion: () => getVersionMock(),
}))
vi.mock("../update/paths.js", () => ({
	isHomebrewInstall: () => isHomebrewInstallMock(),
}))
vi.mock("../update/settings.js", () => ({
	loadAutoUpdateSetting: () => loadAutoUpdateSettingMock(),
	saveAutoUpdateSetting: vi.fn(),
	loadAutoUpdateNoticeShown: () => loadAutoUpdateNoticeShownMock(),
	markAutoUpdateNoticeShown: () => markAutoUpdateNoticeShownMock(),
}))

const { default: startupUpdateExtension } = await import("./startup-update.js")

type Handler = (event: unknown, ctx: unknown) => unknown

function createMockApi() {
	const handlers = new Map<string, Handler>()
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler)
		},
	}
	return { handlers, api: api as unknown as Parameters<typeof startupUpdateExtension>[0] }
}

function makeCtx(opts: { hasUI: boolean; mode?: string }) {
	const setStatus = vi.fn()
	const notify = vi.fn()
	const ctx = {
		hasUI: opts.hasUI,
		mode: opts.mode ?? "tui",
		ui: {
			setStatus,
			notify,
			theme: { bold: (s: string) => s },
		},
	}
	return { ctx, setStatus, notify }
}

describe("startupUpdateExtension", () => {
	beforeEach(() => {
		checkForUpdateMock.mockReset()
		getVersionMock.mockReset()
		isHomebrewInstallMock.mockReset()
		loadAutoUpdateSettingMock.mockReset()
		loadAutoUpdateNoticeShownMock.mockReset()
		markAutoUpdateNoticeShownMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		// Default: auto-update disabled → preserves legacy setStatus behavior
		// for the existing tests below. New tests override per-case.
		loadAutoUpdateSettingMock.mockReturnValue(false)
		loadAutoUpdateNoticeShownMock.mockReturnValue(false)
	})

	it("checks for update on bare 0.0.0 dev build", async () => {
		getVersionMock.mockReturnValue("0.0.0")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).toHaveBeenCalledOnce()
	})

	it("does not check or set status when local version is canary", async () => {
		getVersionMock.mockReturnValue("0.0.0-canary.20260509.abc1234")
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("sets update-available status on stable when remote is newer", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).toHaveBeenCalledOnce()
		const [key, msg] = setStatus.mock.calls[0]
		expect(key).toBe("update-available")
		expect(msg).toContain("kimchi update")
	})

	it("does not set status on stable when no update", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: false })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("skips entirely when hasUI is false", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: false })
		await handler({}, ctx)

		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
	})

	describe("auto-update aware", () => {
		it("suppresses setStatus (no nag) when autoUpdate is enabled and update is available", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(true) // isolate the suppression path
			checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			// Auto-update handles currency on next launch — no footer nag,
			// no version check here, and the onboarding toast is already shown.
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalled()
		})

		it("emits one-time notify and marks shown when autoUpdate is enabled and notice not yet shown", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(false)
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(notify).toHaveBeenCalledOnce()
			expect(notify.mock.calls[0][0]).toContain("Run `/update` to disable")
			expect(markAutoUpdateNoticeShownMock).toHaveBeenCalledOnce()
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
		})

		it("does not notify when autoUpdate is enabled and notice already shown", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(true)
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(notify).not.toHaveBeenCalled()
			expect(markAutoUpdateNoticeShownMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
		})

		it("preserves setStatus behavior and skips notice when autoUpdate is disabled", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(false)
			loadAutoUpdateNoticeShownMock.mockReturnValue(false)
			checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(setStatus).toHaveBeenCalledOnce()
			const [key] = setStatus.mock.calls[0]
			expect(key).toBe("update-available")
			expect(notify).not.toHaveBeenCalled()
			expect(markAutoUpdateNoticeShownMock).not.toHaveBeenCalled()
		})

		it("does not suppress footer for Homebrew users with autoUpdate enabled", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(true)
			isHomebrewInstallMock.mockReturnValue(true)
			checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			// Homebrew installs are skipped by launch auto-update, so the
			// footer hint must still show — otherwise the user gets neither
			// a background update nor a `brew upgrade` hint.
			expect(checkForUpdateMock).toHaveBeenCalledOnce()
			expect(setStatus).toHaveBeenCalledOnce()
			const [, msg] = setStatus.mock.calls[0]
			expect(msg).toContain("brew upgrade kimchi")
			expect(notify).not.toHaveBeenCalled()
		})
	})

	describe("auto-update settings error handling", () => {
		let stderrSpy: ReturnType<typeof vi.spyOn>

		beforeEach(() => {
			stderrSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		})

		afterEach(() => {
			stderrSpy.mockRestore()
		})

		it("swallows errors from loadAutoUpdateSetting and returns early without setStatus", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockImplementation(() => {
				throw new Error("settings dir unwritable")
			})
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await expect(handler({}, ctx)).resolves.toBeUndefined()

			// Nothing should render, and the existing checkForUpdate path
			// must NOT run when the settings layer is broken.
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalled()
			expect(markAutoUpdateNoticeShownMock).not.toHaveBeenCalled()
			expect(stderrSpy).toHaveBeenCalledOnce()
			expect(stderrSpy.mock.calls[0][0]).toContain("settings dir unwritable")
		})

		it("swallows errors from markAutoUpdateNoticeShown", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(false)
			markAutoUpdateNoticeShownMock.mockImplementation(() => {
				throw new Error("disk full")
			})
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, notify } = makeCtx({ hasUI: true })
			await expect(handler({}, ctx)).resolves.toBeUndefined()

			// The notify ran, but the throw happened AFTER notify. The
			// catch must swallow the error so session_start doesn't crash.
			expect(notify).toHaveBeenCalledOnce()
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(stderrSpy).toHaveBeenCalledOnce()
			expect(stderrSpy.mock.calls[0][0]).toContain("disk full")
		})
	})
})

describe("update notice env (KIMCHI_UPDATE_NOTICE + KIMCHI_NO_UPDATE_CHECK)", () => {
	let prevNotice: string | undefined
	let prevDisabled: string | undefined

	beforeEach(() => {
		prevNotice = process.env.KIMCHI_UPDATE_NOTICE
		prevDisabled = process.env.KIMCHI_NO_UPDATE_CHECK
		// The outer describe's beforeEach doesn't reach this top-level
		// describe, and the shell that launches the harness exports
		// KIMCHI_NO_UPDATE_CHECK=1 — reset every mock (implementations leak
		// from the outer tests otherwise) and start each test from a clean
		// env slate so ambient values can't flip a branch.
		checkForUpdateMock.mockReset()
		getVersionMock.mockReset()
		isHomebrewInstallMock.mockReset()
		loadAutoUpdateSettingMock.mockReset()
		loadAutoUpdateNoticeShownMock.mockReset()
		markAutoUpdateNoticeShownMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		loadAutoUpdateSettingMock.mockReturnValue(false)
		loadAutoUpdateNoticeShownMock.mockReturnValue(false)
		delete process.env.KIMCHI_UPDATE_NOTICE
		delete process.env.KIMCHI_NO_UPDATE_CHECK
	})

	afterEach(() => {
		if (prevNotice === undefined) delete process.env.KIMCHI_UPDATE_NOTICE
		else process.env.KIMCHI_UPDATE_NOTICE = prevNotice
		if (prevDisabled === undefined) delete process.env.KIMCHI_NO_UPDATE_CHECK
		else process.env.KIMCHI_NO_UPDATE_CHECK = prevDisabled
	})

	it("shows the notice-only message when outdated", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("1.14.0")
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "v1.16.0",
			currentVersion: "1.14.0",
		})
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(checkForUpdateMock.mock.calls[0][0]).toMatchObject({
			currentVersion: "1.14.0",
			skipCache: false,
			ignoreUpdateCheckDisabled: true,
		})
		// The notice renders once via notify; the status line stays untouched.
		expect(setStatus).not.toHaveBeenCalled()
		expect(notify).toHaveBeenCalledOnce()
		// Exactly one "v" per version — the approved wording.
		const [msg, level] = notify.mock.calls[0]
		expect(msg).toBe("A new Kimchi version is available: v1.16.0 (current v1.14.0).")
		expect(level).toBe("info")
	})

	it("normalizes versions without a v prefix and never doubles an existing one", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("v1.14.0")
		checkForUpdateMock.mockResolvedValue({
			hasUpdate: true,
			latestVersion: "1.16.0",
			currentVersion: "v1.14.0",
		})
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, notify } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(notify.mock.calls[0][0]).toBe("A new Kimchi version is available: v1.16.0 (current v1.14.0).")
	})

	it("shows no notice when already on the latest version", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("v1.16.0")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: false })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).not.toHaveBeenCalled()
		expect(notify).not.toHaveBeenCalled()
	})

	it("stays silent when the check fails", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("1.14.0")
		checkForUpdateMock.mockRejectedValue(new Error("github unreachable"))
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
		await expect(handler({}, ctx)).resolves.toBeUndefined()
		expect(setStatus).not.toHaveBeenCalled()
		expect(notify).not.toHaveBeenCalled()
	})

	it("never runs outside the TUI (ACP/RPC/JSON/print exclusion)", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("1.14.0")
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus, notify } = makeCtx({ hasUI: true, mode: "rpc" })
		await handler({}, ctx)

		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
		expect(notify).not.toHaveBeenCalled()
	})

	it("falls through to the existing path when only KIMCHI_NO_UPDATE_CHECK is set", async () => {
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		getVersionMock.mockReturnValue("1.14.0")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true, latestVersion: "v1.16.0" })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		// The no-network guarantee for this case lives in checkForUpdate's
		// short-circuit (workflow.test.ts); the extension keeps its existing
		// path, whose message points at `kimchi update`.
		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(checkForUpdateMock.mock.calls[0][0].ignoreUpdateCheckDisabled).toBeUndefined()
		const [, msg] = setStatus.mock.calls[0]
		expect(msg).toContain("kimchi update")
	})

	it("falls through to the existing path when only KIMCHI_UPDATE_NOTICE is set", async () => {
		process.env.KIMCHI_UPDATE_NOTICE = "1"
		getVersionMock.mockReturnValue("1.14.0")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true, latestVersion: "v1.16.0" })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		const [, msg] = setStatus.mock.calls[0]
		expect(msg).toContain("kimchi update")
	})
})
