import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { gunzip, gzip } from "node:zlib"
import { lock } from "proper-lockfile"

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const CHUNK_BYTES = 64 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** A stalled disk must not hold up startup, session replacement or shutdown. */
export async function recordingDeadline<T>(operation: Promise<T>, timeoutMs = 1000): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}
export const RECORDING_LIMITS = {
	slots: 16,
	rawBytes: 32 * 1024 * 1024,
	compressedBytes: 8 * 1024 * 1024,
	queuedBytes: 1024 * 1024,
}

type RecordingStatus = "recording" | "complete" | "size-limit" | "queue-limit" | "storage-error"
export interface RecordingMetadata {
	version: 1
	id: string
	sessionId: string
	pid: number
	startedAt: string
	status: RecordingStatus
	cols: number
	rows: number
	chunks: number
	rawBytes: number
	compressedBytes: number
	queueHighWaterBytes: number
	duration: number
}

export interface Recording {
	metadata: RecordingMetadata
	cast: string
}

interface RecorderOptions {
	root: string
	sessionId: string
	cols: number
	rows: number
	limits?: Partial<typeof RECORDING_LIMITS>
	now?: () => number
}

async function readMetadata(directory: string): Promise<RecordingMetadata | undefined> {
	try {
		const value = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
		if (value.version === 1 && typeof value.id === "string" && typeof value.sessionId === "string") return value
	} catch {
		// A missing or damaged slot is reusable. Recording is best effort.
	}
}

function isLive(metadata: RecordingMetadata): boolean {
	if (metadata.pid <= 0 || !Number.isInteger(metadata.pid)) return false
	try {
		process.kill(metadata.pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** Fixed slots bound aggregate disk usage, including simultaneous Kimchi processes. */
async function reserveSlot(options: RecorderOptions, slots: number): Promise<string> {
	await mkdir(options.root, { recursive: true, mode: 0o700 })
	const release = await lock(options.root, { retries: { retries: 3, minTimeout: 50, maxTimeout: 100 } })
	try {
		const candidates: { directory: string; at: number }[] = []
		for (let i = 0; i < slots; i++) {
			const directory = join(options.root, `slot-${i}`)
			const metadata = await readMetadata(directory)
			if (metadata && isLive(metadata)) continue
			candidates.push({ directory, at: metadata ? Date.parse(metadata.startedAt) : 0 })
			if (metadata && Date.now() - Date.parse(metadata.startedAt) > RETENTION_MS) {
				await rm(directory, { recursive: true, force: true })
			}
		}
		candidates.sort((a, b) => a.at - b.at)
		const slot = candidates[0]
		if (!slot) throw new Error("All terminal recording slots are in use")
		await rm(slot.directory, { recursive: true, force: true })
		await mkdir(slot.directory, { mode: 0o700 })
		// Publish ownership while still holding the allocation lock.
		await writeFile(
			join(slot.directory, "metadata.json"),
			JSON.stringify({
				version: 1,
				id: randomUUID(),
				sessionId: options.sessionId,
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		)
		return slot.directory
	} finally {
		await release()
	}
}

/** Captures a playable prefix. No terminal write waits for compression or disk I/O. */
export class TerminalRecorder {
	readonly metadata: RecordingMetadata
	private readonly limits: typeof RECORDING_LIMITS
	private readonly now: () => number
	private readonly started: number
	private lastTimeMs = 0
	private admittedBytes = 0
	private queuedBytes = 0
	private pending: string[] = []
	private pendingBytes = 0
	private writing: Promise<void> = Promise.resolve()
	private timer: NodeJS.Timeout | undefined
	private closed = false
	private discardQueued = false

	private constructor(
		readonly directory: string,
		options: RecorderOptions,
	) {
		this.limits = { ...RECORDING_LIMITS, ...options.limits }
		this.now = options.now ?? (() => performance.now())
		this.started = this.now()
		this.metadata = {
			version: 1,
			id: randomUUID(),
			sessionId: options.sessionId,
			pid: process.pid,
			startedAt: new Date().toISOString(),
			status: "recording",
			cols: options.cols,
			rows: options.rows,
			chunks: 0,
			rawBytes: 0,
			compressedBytes: 0,
			queueHighWaterBytes: 0,
			duration: 0,
		}
	}

	static async create(options: RecorderOptions): Promise<TerminalRecorder> {
		const directory = await reserveSlot(options, options.limits?.slots ?? RECORDING_LIMITS.slots)
		const recorder = new TerminalRecorder(directory, options)
		await recorder.saveMetadata()
		recorder.enqueue(
			`${JSON.stringify({ version: 3, term: { cols: options.cols, rows: options.rows }, timestamp: Date.now() / 1000 })}\n`,
		)
		await recorder.flush()
		return recorder
	}

	write(data: string): void {
		if (data) this.event("o", data)
	}

	resize(cols: number, rows: number): void {
		this.event("r", `${Math.max(1, cols)}x${Math.max(1, rows)}`)
	}

	private event(code: "o" | "r", data: string): void {
		if (this.closed || this.metadata.status !== "recording") return
		// String length is a lower bound on encoded size. Reject huge writes before copying them into JSON.
		if (!this.hasCapacity(data.length)) return
		// Round the absolute elapsed time, then subtract, so rounding cannot accumulate drift.
		const timeMs = Math.max(this.lastTimeMs, Math.round(this.now() - this.started))
		const line = `${JSON.stringify([(timeMs - this.lastTimeMs) / 1000, code, data])}\n`
		const previous = this.lastTimeMs
		this.lastTimeMs = timeMs
		if (!this.enqueue(line)) this.lastTimeMs = previous
	}

	private hasCapacity(bytes: number): boolean {
		if (this.admittedBytes + bytes > this.limits.rawBytes) {
			this.metadata.status = "size-limit"
			void this.flush()
			return false
		}
		if (this.queuedBytes + bytes > this.limits.queuedBytes) {
			this.metadata.status = "queue-limit"
			void this.flush()
			return false
		}
		return true
	}

	private enqueue(line: string): boolean {
		const bytes = Buffer.byteLength(line)
		if (!this.hasCapacity(bytes)) return false
		this.pending.push(line)
		this.pendingBytes += bytes
		this.admittedBytes += bytes
		this.queuedBytes += bytes
		this.metadata.queueHighWaterBytes = Math.max(this.metadata.queueHighWaterBytes, this.queuedBytes)
		if (this.pendingBytes >= CHUNK_BYTES) void this.flush()
		else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 250).unref()
		return true
	}

	async flush(): Promise<void> {
		clearTimeout(this.timer)
		this.timer = undefined
		const data = this.pending.join("")
		const bytes = this.pendingBytes
		const duration = this.lastTimeMs / 1000
		this.pending = []
		this.pendingBytes = 0
		this.writing = this.writing.then(async () => {
			try {
				if (data && !this.discardQueued && this.metadata.status !== "storage-error") {
					const compressed = await compress(data, { level: 1 })
					if (this.metadata.compressedBytes + compressed.length + 4 > this.limits.compressedBytes) {
						this.metadata.status = "size-limit"
						this.discardQueued = true
					} else {
						// Length framing lets a reader ignore a partially written final chunk after a crash.
						const length = Buffer.alloc(4)
						length.writeUInt32BE(compressed.length)
						await appendFile(join(this.directory, "output.bin"), Buffer.concat([length, compressed]), { mode: 0o600 })
						this.metadata.chunks++
						this.metadata.compressedBytes += compressed.length + 4
						this.metadata.rawBytes += bytes
						this.metadata.duration = duration
					}
				}
				await this.saveMetadata()
			} catch {
				this.metadata.status = "storage-error"
			} finally {
				this.queuedBytes -= bytes
			}
		})
		await this.writing
	}

	async close(): Promise<void> {
		if (this.closed) return this.writing
		this.event("o", "") // Preserve the final idle interval.
		this.closed = true
		await this.flush()
		if (this.metadata.status === "recording") this.metadata.status = "complete"
		this.metadata.pid = 0
		try {
			await this.saveMetadata()
		} catch {
			this.metadata.status = "storage-error"
		}
	}

	private async saveMetadata(): Promise<void> {
		const file = join(this.directory, "metadata.json")
		await writeFile(`${file}.tmp`, JSON.stringify(this.metadata), { mode: 0o600 })
		await rename(`${file}.tmp`, file)
	}
}

/** Read only committed chunks; an interrupted write cannot corrupt earlier frames. */
export async function readRecordings(root: string, sessionId: string): Promise<Recording[]> {
	let slots: string[]
	try {
		slots = await readdir(root)
	} catch {
		return []
	}
	const recordings: Recording[] = []
	let remainingBytes = RECORDING_LIMITS.rawBytes
	const candidates = await Promise.all(
		slots
			.filter((name) => /^slot-\d+$/.test(name))
			.map(async (name) => ({
				directory: join(root, name),
				metadata: await readMetadata(join(root, name)),
			})),
	)
	candidates.sort((a, b) => (b.metadata?.startedAt ?? "").localeCompare(a.metadata?.startedAt ?? ""))
	for (const { directory, metadata } of candidates) {
		if (!metadata || metadata.sessionId !== sessionId || !metadata.chunks) continue
		if (Date.now() - Date.parse(metadata.startedAt) > RETENTION_MS || metadata.rawBytes > remainingBytes) continue
		try {
			const encoded = await readFile(join(directory, "output.bin"))
			if (metadata.compressedBytes > RECORDING_LIMITS.compressedBytes) continue
			const chunks: Buffer[] = []
			let bytes = 0
			let offset = 0
			for (let i = 0; i < metadata.chunks; i++) {
				const length = encoded.readUInt32BE(offset)
				offset += 4
				if (offset + length > metadata.compressedBytes) throw new Error("Incomplete recording chunk")
				const decoded = await decompress(encoded.subarray(offset, offset + length), {
					maxOutputLength: remainingBytes - bytes,
				})
				offset += length
				bytes += decoded.length
				chunks.push(decoded)
			}
			// Allocation can reuse a closed slot while an export is reading it.
			if ((await readMetadata(directory))?.id !== metadata.id) continue
			remainingBytes -= bytes
			recordings.push({ metadata, cast: Buffer.concat(chunks).toString("utf8") })
		} catch {
			// Missing/corrupt/evicted recordings do not break the conversation export.
		}
	}
	return recordings.reverse()
}
