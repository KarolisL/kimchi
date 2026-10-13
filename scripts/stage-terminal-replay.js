import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const source = join(dirname(fileURLToPath(import.meta.url)), "../resources/terminal-replay")
const cache = join(source, "generated")
const release = "https://github.com/asciinema/asciinema-player/releases/download/v3.17.0/"
const tree = "https://raw.githubusercontent.com/asciinema/asciinema-player/v3.17.0/"
const assets = [
	[
		"asciinema-player.min.js",
		`${release}asciinema-player.min.js`,
		"a13c37632e1b5c49fe9128417b9319a9b5bc64cb457dd5ae52cbba8a3aceb880",
	],
	[
		"asciinema-player.css",
		`${release}asciinema-player.css`,
		"f619fe17597043564f03b2c6918b3daf890ee8b912fb408542fba11afade4fdb",
	],
	["LICENSE", `${tree}LICENSE`, "63422284ed65be54ab38d8a94e7518d27e222fbb26c9ae4cd984c63926e91c12"],
	["VT-LICENSE-MIT", `${tree}src/vt/LICENSE_MIT`, "1e10910c6ab23347b880f9e05df65f01f262dd179c4127c4fc0991670ecfa49a"],
	[
		"VT-LICENSE-APACHE",
		`${tree}src/vt/LICENSE_APACHE`,
		"62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
	],
	[
		"XTERM-LICENSE",
		"https://raw.githubusercontent.com/xtermjs/xterm.js/f447274f430fd22513f6adbf9862d19524471c04/LICENSE",
		"b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd",
	],
]
const digest = (data) => createHash("sha256").update(data).digest("hex")

/** Download once at setup/build time; playback and exports never need the network. */
export async function stageTerminalReplay(destination = cache) {
	mkdirSync(cache, { recursive: true })
	await Promise.all(
		assets.map(async ([name, url, sha256]) => {
			const file = join(cache, name)
			if (existsSync(file) && digest(readFileSync(file)) === sha256) return
			const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
			if (!response.ok) throw new Error(`Cannot stage terminal replay ${name}: HTTP ${response.status}`)
			const data = Buffer.from(await response.arrayBuffer())
			if (digest(data) !== sha256) throw new Error(`Terminal replay asset checksum mismatch: ${name}`)
			writeFileSync(file, data)
		}),
	)
	cpSync(join(source, "player.html"), join(cache, "player.html"))
	if (destination !== cache) {
		mkdirSync(destination, { recursive: true })
		for (const name of [...assets.map(([name]) => name), "player.html"])
			cpSync(join(cache, name), join(destination, name))
	}
}
