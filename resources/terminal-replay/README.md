# Terminal replay UI

`player.html` contains Kimchi's replay page. `scripts/stage-terminal-replay.js` fetches the pinned playback assets during setup/build, verifies their SHA-256 hashes and caches them in the ignored `generated/` directory. Later builds reuse matching files without downloading them again.

Only authored code and documentation are tracked here. The binary build stages the complete generated player in `dist/share/kimchi/terminal-replay/`. HTML exports embed the assets and play offline.

Run `pnpm install` or `pnpm run build` after a fresh checkout. Recheck offline playback, resize, Unicode, seeking and standalone downloads when changing the asset pin.
