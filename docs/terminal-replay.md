# Terminal recordings in session exports

Kimchi automatically records interactive terminal output so an unexpected display problem can be watched later. Run `/export report.html`, choose **Transcript + replay (raw terminal output)**, then open the HTML and select **Replay** beside **JSONL** in the header. **Transcript** returns to the conversation at the same scroll position. Playback fills the viewing area and works locally, with play, pause, seeking, speed and recorded terminal resizes. It makes no model calls or recording-service requests.

Changing speed preserves both position and play/pause state. Returning to the transcript pauses replay; reopening keeps the same position, speed and part. The browser retains only the selected part decoded while the HTML stays open. Switching parts replaces that cache. The previous screen stays visible while a speed change prepares its replacement; recorded output and pauses are unchanged. **Download part**, next to the part selector, saves the selected part and its player as a standalone HTML file that opens offline.

The default export choice is **Transcript only (redacted)**. A terminal recording can contain visible drafts, secrets and text cleared from the screen. The recording is raw; the transcript keeps its existing redaction. Review the recording before sharing the file. JSONL and noninteractive exports do not include raw recordings.

## Recording limits

| Limit | Default |
| --- | --- |
| Pending recording data | 1 MiB per active recorder |
| One recording part | 32 MiB decoded or 8 MiB compressed, whichever is reached first |
| Retained parts across sessions | 16 slots, at most 128 MiB compressed data plus small metadata files |
| Retention | Inactive parts older than 7 days are removed when another part starts; expired parts are excluded from export |
| One export | All retained parts for that session, compressed; each part is repacked separately and only the selected part is decoded for playback |

Recordings live under the harness directory in `terminal-recordings/`, with owner-only directory and file permissions. Multiple processes reserve separate slots. Old inactive parts are replaced first; an active part is never evicted. If every slot is active, a new session continues without recording.

When a part fills, capture continues in the next numbered part. The recorder reconstructs the screen from the completed part in its asynchronous write queue and saves a starting checkpoint for the next part. It does not redraw the live terminal or run a second terminal emulator on ordinary writes. Later parts remain playable after older parts are removed. A five-day session can therefore keep recording, but the amount retained depends on output volume rather than elapsed time. Idle time adds almost no data.

The HTML identifies continued parts, buffer limits, storage errors and interrupted capture. If a single frame plus its starting checkpoint cannot fit in a part, capture stops with a size-limit notice. Excessive output or slow storage can still fill the bounded queue and stop recording. An abruptly killed process can lose its final unflushed fraction; committed chunks remain readable. Recording writes never wait for disk I/O, and lifecycle operations give a stalled recorder at most one second before proceeding. The explicit raw replay export may take longer while retained parts are read and compressed; transcript-only exports skip this work. Base64 and the embedded player make an HTML export larger than the stored compressed data.

Set `"terminalRecording": false` in `~/.config/kimchi/harness/settings.json` before launching Kimchi to disable recording. `--no-session`, print, RPC and ACP sessions do not record a terminal. Turning capture off does not erase existing recordings; remove `terminal-recordings/` while Kimchi is closed to clear them.

## What replay proves

The player receives captured output bytes, timing and dimensions. It can show incorrect clearing, duplicated lines, cursor placement, wrapping, menus and streaming. Each startup or session replacement starts a separate recording, with numbered parts and timestamps in the selector. A full repaint starts a replacement session's recording so differential rendering has a valid initial frame; size-based part rotation preserves the existing screen instead.

This is terminal playback, not pixel video. Fonts, Unicode widths, terminal-specific sequences and inline image protocols may render differently. Use a screen recording for terminal-host or GPU defects. Playing an old recording also cannot prove a fix: use a controlled TUI regression to execute the changed renderer.

## Implementation and validation

`src/terminal-replay/` owns capture, bounded storage and export integration. A small adapter starts capture before Pi's first interactive frame; session hooks own export consent and cleanup. Writes to both attached stdout and stderr are observed, including terminal methods that bypass `Terminal.write`. Raw input is not recorded. Output is encoded as asciicast v3; independently compressed, length-framed chunks make incomplete final writes ignorable.

UTF-8 string writes are captured without allocating an intermediate Buffer. The tap normalizes lone UTF-16 surrogates as Node's UTF-8 encoding does, and retains the streaming decoder for Buffer writes and other encodings. This reduces work on each normal redraw without changing capture timing or storage limits.

The offline player uses pinned assets fetched and verified during setup/build, outside the tracked source tree. It runs in a sandboxed iframe with network access disabled by Content Security Policy. The transcript and subagent viewers keep their existing rendering. Generated upstream export templates are not edited.

Run focused contracts with `pnpm exec vitest run src/terminal-replay src/utils/export-post-process.test.ts src/utils/export-post-process.redaction.test.ts`. After `pnpm run build:binary`, run `node scripts/run-tui-e2e.js 'session-replay[.]test[.]ts$' --trace`. Anchor the filename: test filters match the complete path, including worktree names.

Run `pnpm exec tsx src/terminal-replay/player.check.ts` with Playwright's installed Chromium to check the exported player in a real browser. This preserves a deliberate duplicate-line defect across retained parts, then verifies clearing, Unicode placement, resize wrapping, controls, transcript scroll, subagent navigation and a downloaded part playing with networking disabled. For an installed Chrome, use `REPLAY_BROWSER_CHANNEL=chrome REPLAY_BROWSER_HEADED=1` before the command. Chrome 155.0.8059.40 in headless mode missed native clicks near the bottom of a sandboxed iframe, including in a minimal page without the player; headed Chrome and Playwright's Chromium 147 did not reproduce that problem.

For real-model evidence, use the bundled `resources/skills/kimchi-tmux/SKILL.md`, an isolated HOME/tmux server and `KIMCHI_BINARY` pointing at this checkout's binary. Capture actual output, export it, open the file offline, test pause/seek/speed/resize, and compare terminal text placement at known times. Keep raw artifacts and temporary credentials out of Git; remove test credentials when done.
