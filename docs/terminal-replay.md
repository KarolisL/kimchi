# Terminal recordings in session exports

Kimchi automatically records interactive terminal output so an unexpected display problem can be watched later. Run `/export report.html`, choose **Transcript + replay (raw terminal output)**, then open the HTML and select **Terminal replay**. Playback works locally, with play, pause, seeking, speed and recorded terminal resizes. It makes no model calls or recording-service requests.

The default export choice is **Transcript only (redacted)**. A terminal recording can contain visible drafts, secrets and text cleared from the screen. The recording is raw; the transcript keeps its existing redaction. Review the recording before sharing the file. JSONL and noninteractive exports do not include raw recordings.

## Recording limits

| Limit | Default |
| --- | --- |
| Pending recording data | 1 MiB per active recorder |
| One recorded terminal visit | 32 MiB decoded or 8 MiB compressed, whichever is reached first |
| Retained visits across sessions | 16 slots, at most 128 MiB compressed data plus small metadata files |
| Retention | Inactive visits older than 7 days are removed when another visit starts; expired visits are excluded from export |
| One export | At most 32 MiB decoded terminal data, selecting recent retained visits |

Recordings live under the harness directory in `terminal-recordings/`, with owner-only directory and file permissions. Multiple processes reserve separate slots. Old inactive visits are replaced first; an active visit is never evicted. If every slot is active, a new session continues without recording.

Capture stops at a limit instead of dropping earlier ANSI output: later frames depend on the initial screen and cursor state. The HTML identifies a size limit, buffer limit, storage error, or an interrupted capture. An abruptly killed process can lose its final unflushed fraction; already committed chunks remain readable. Recording writes never wait for disk I/O, and lifecycle operations give a stalled recorder at most one second before proceeding.

Set `"terminalRecording": false` in `~/.config/kimchi/harness/settings.json` before launching Kimchi to disable recording. `--no-session`, print, RPC and ACP sessions do not record a terminal. Turning capture off does not erase existing recordings; remove `terminal-recordings/` while Kimchi is closed to clear them.

## What replay proves

The player receives captured output bytes, timing and dimensions. It can show incorrect clearing, duplicated lines, cursor placement, wrapping, menus and streaming. Each startup or session replacement starts a separate recorded visit; retained visits for the exported session appear in the visit selector. A full repaint starts a replacement visit so differential rendering has a valid initial frame.

This is terminal playback, not pixel video. Fonts, Unicode widths, terminal-specific sequences and inline image protocols may render differently. Use a screen recording for terminal-host or GPU defects. Playing an old recording also cannot prove a fix: use a controlled TUI regression to execute the changed renderer.

## Implementation and validation

`src/terminal-replay/` owns capture, bounded storage and export integration. A small adapter starts capture before Pi's first interactive frame; session hooks own export consent and cleanup. Writes to both attached stdout and stderr are observed, including terminal methods that bypass `Terminal.write`. Raw input is not recorded. Output is encoded as asciicast v3; independently compressed, length-framed chunks make incomplete final writes ignorable.

The offline player is the pinned Apache-2.0 asciinema-player distribution in `resources/terminal-replay/`, with retained licenses. It runs in a sandboxed iframe with network access disabled by Content Security Policy. The transcript and subagent viewers keep their existing rendering. Generated upstream export templates are not edited.

Run focused contracts with `pnpm exec vitest run src/terminal-replay src/utils/export-post-process.test.ts src/utils/export-post-process.redaction.test.ts`. After `pnpm run build:binary`, run `node scripts/run-tui-e2e.js 'session-replay[.]test[.]ts$' --trace`. Anchor the filename: test filters match the complete path, including worktree names.

With Chrome installed, run `REPLAY_BROWSER_CHANNEL=chrome pnpm exec tsx src/terminal-replay/player.check.ts` to check the exported player in a real browser. This preserves a deliberate duplicate-line defect, then verifies clearing, Unicode placement, resize wrapping, controls and offline loading. Omitting the channel uses Playwright's installed Chromium.

For real-model evidence, use the bundled `resources/skills/kimchi-tmux/SKILL.md`, an isolated HOME/tmux server and `KIMCHI_BINARY` pointing at this checkout's binary. Capture actual output, export it, open the file offline, test pause/seek/speed/resize, and compare terminal text placement at known times. Keep raw artifacts and temporary credentials out of Git; remove test credentials when done.
