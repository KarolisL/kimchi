# Terminal recordings in session exports

Kimchi automatically records interactive terminal output so an unexpected display problem can be watched later. Run `/export report.html`, choose **Transcript + replay (raw terminal output)**, then open the HTML and select **Replay** beside **JSONL** in the header. **Transcript** returns to the conversation at the same scroll position. Playback fills the viewing area and works locally, with play, pause, seeking, speed and recorded terminal resizes. It makes no model calls or recording-service requests.

Changing speed preserves both position and play/pause state. Returning to the transcript pauses replay; reopening keeps the same position, speed and part. The browser retains only the selected part decoded while the HTML stays open. Switching parts replaces that cache. The previous screen stays visible while a speed change prepares its replacement; recorded output and pauses are unchanged. **Download part**, next to the part selector, saves the selected part and its player as a standalone HTML file that opens offline.

## Linked harness steps

New recordings include a **Harness steps** panel beside the terminal. Select a prompt, completed response, tool call, tool result or error to pause on its associated screen and inspect its text. **Previous step** and **Next step** move through the selected part. **Next error** jumps to its next captured failure; **Pause on errors** stops playback there automatically. Resuming continues beyond that failure. Scrubbing or playing the recording follows the trace. Selecting another recording part loads that part's steps, and **Download part** includes them in the offline file.

The harness observes each step after the interactive UI handles it, then attaches it to the next completed terminal frame. The marker carries the delay between observation and that frame. Several steps can share a frame; collapsed tools, overlays and scrolling can hide their content. A step with no completed frame remains inspectable and says so rather than seeking to an unrelated screen. Older recordings say **No linked steps in this recording.** Their terminal playback still works.

Tool results follow live completion order, including parallel calls. They contain the result and failure flag supplied to the TUI; later transcript replacements can differ. Error navigation relies on the harness reporting a failure, so an error returned as successful content remains a normal result in the trace. Distinct frames remain individually seekable even when they share a clock sample.

Expand **Session details**, **Saved session content** or **Request diagnostics** inside a selected step to inspect the original export's extra information. Where available, this includes model/provider, stop reason, input/output/cache tokens, reported cost, response and trace IDs, saved tool arguments/results, HTTP status, retry information and request errors. Request duration measures time to response headers, not the complete streamed response. Reported cost is the value saved by the harness, not verified billing.

These details are assembled at export time from the already-redacted session data. New prompt/response markers carry their original message timestamp and optional response ID; tools use their call ID. Only unique matches within the same session are attached. Missing or ambiguous matches are shown explicitly, including older prompt/response markers without those identifiers. Related diagnostics follow the matched response's parent chain without crossing another message. Saved final content is labelled separately because it can differ from the live output on the recorded screen. The same details travel with **Download part**.

Captured trace text stays bounded inside the recording's storage budget. Tool arguments and results can contain sensitive text even when the terminal shows a collapsed summary. The raw export choice covers both the terminal and its captured trace; transcript redaction does not change them. Saved-session enrichment is separately bounded to 64 KiB per step and 1 MiB per part, with shortening and omission notices. It adds export work and HTML size; live capture only copies the message timestamp/response ID. Model reasoning, image payloads and continuous debug logs are not recorded. Resumed history is not presented as newly executed steps, and expired parts also lose their steps.

The replay page follows the transcript export's compact monospace design, with harness steps on the left and the recorded terminal beside them. All parts use Kimchi's play/pause button and seek slider. The browser mounts only visible step rows and avoids a DOM node for every timeline marker. Trace navigation and error pauses stay available; this reduces browser work without changing harness capture. Standalone downloads use the same layout and controls.

This supports inspection of a past run. It does not pause a live agent, inspect process memory, re-execute tools or prove that a later code change fixes the issue.

### Research and implementation choice

The useful pattern in [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) is selecting an action to see the corresponding visual state and details. [rrweb custom events](https://github.com/rrweb-io/rrweb/blob/main/docs/recipes/custom-event.md) provide a similar link between semantic events and a recording timeline. Neither is a terminal recorder, so this implementation adds semantic markers to the existing terminal stream.

The existing [player marker API](https://docs.asciinema.org/manual/player/markers/) already supports playback callbacks and seeking. Kimchi keeps those markers in captured order, gives them readable labels and adds its trace panel without another player or recording dependency. The [pinned player driver](https://github.com/asciinema/asciinema-player/blob/v3.17.0/src/driver/recording.js) and browser checks establish the behavior used here.

Pinned Pi 0.85.1 supplies public session events but no terminal-to-trace mapping. Its extension hooks precede the interactive UI subscriber and can replace finalized messages; a subscriber after the UI sees the final event. The terminal redraw is scheduled later, so an event timestamp alone can stop before an error appears. Completed synchronized-output bursts supply the frame boundary. The [Pi package catalog](https://pi.dev/packages) and bounded upstream issue/PR searches did not reveal a ready-made adapter for this flow. No upstream patch is needed.

The pinned session emits message events to subscribers before saving their entries. Reading its current leaf inside that subscriber would therefore link to an earlier entry. Export enrichment uses the original message identity instead and declines ambiguous matches. If redaction masked a saved response ID, a unique role/timestamp match still allows its details to appear while the ID stays masked. It preserves the captured frame and failure flag when saved transcript replacements differ.

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

### Owning the replay UI

`scripts/stage-terminal-replay.js` downloads and checks the player assets during setup/build. It does not record sessions or run during playback. Removing only that script would leave the exporter without its assets. A company-designed replay page can use either the current engine behind custom controls or a different terminal renderer.

The following alternatives were checked against their upstream documentation on 2026-10-13. Only the current player has been tested with Kimchi's recordings; the integration assessments are engineering judgments, not measured comparisons.

| Option | What it supplies | Work for Kimchi |
| --- | --- | --- |
| Current player with Kimchi controls | Timed playback, seeking, markers and terminal rendering. Its [controls option](https://docs.asciinema.org/manual/player/options/#controls) hides the stock bar. | Implemented: Kimchi owns the play/seek controls and page design for every part. This keeps the player dependency. |
| [xterm.js](https://github.com/xtermjs/xterm.js) | A terminal renderer with public [write, reset and resize APIs](https://xtermjs.org/docs/api/terminal/classes/terminal/). Kimchi already uses its headless package for part checkpoints. | Preferred candidate if removing the current player is required. Add the browser package, own playback timing and seeking, and reuse the trace panel, parts and downloads. Package assets through the normal build instead of downloading release files. |
| [ghostty-web](https://github.com/coder/ghostty-web) | Ghostty's WASM terminal engine with an API intended to resemble xterm.js. | Another renderer candidate; needs the same playback controller plus verification of WASM loading in the offline, sandboxed export. No Kimchi compatibility or performance result yet. |
| [tty-player](https://github.com/chris-morgan/tty-player) | A video-like web component for ttyrec recordings. | Poorer fit: a different recording format, and its README still lists migration from term.js to xterm.js as unfinished. |

The current player's [pinned license](https://github.com/asciinema/asciinema-player/blob/v3.17.0/LICENSE) is Apache-2.0; [xterm.js](https://github.com/xtermjs/xterm.js/blob/master/LICENSE), [ghostty-web](https://github.com/coder/ghostty-web/blob/main/LICENSE) and tty-player use MIT. These allow a company-designed interface while retaining the required notices with distributed code. A visible third-party badge and a distributed license notice are separate concerns; changing engines does not make third-party code notice-free. Generated notices need not be committed as vendored files in this PR.

A renderer replacement can preserve the recording format and capture path, so it adds no live harness work. Its browser CPU, memory and fidelity still need measurement. Acceptance must cover backwards seeks, equal-time failure frames, resizes, Unicode and cursor state, speed changes, dense traces, part checkpoints, and offline downloads before replacing the tested engine. Building a terminal emulator from scratch would add much more maintenance than owning the small playback UI.

Run focused contracts with `pnpm exec vitest run src/terminal-replay src/utils/export-post-process.test.ts src/utils/export-post-process.redaction.test.ts`. After `pnpm run build:binary`, run `node scripts/run-tui-e2e.js 'session-replay[.]test[.]ts$' --trace`. Anchor the filename: test filters match the complete path, including worktree names.

Run `pnpm exec tsx src/terminal-replay/player.check.ts` with Playwright's installed Chromium to check the exported player in a real browser. This preserves a deliberate duplicate-line defect across retained parts, then verifies clearing, Unicode placement, resize wrapping, controls, transcript scroll, subagent navigation and a downloaded part playing with networking disabled. For an installed Chrome, use `REPLAY_BROWSER_CHANNEL=chrome REPLAY_BROWSER_HEADED=1` before the command. Chrome 155.0.8059.40 in headless mode missed native clicks near the bottom of a sandboxed iframe, including in a minimal page without the player; headed Chrome and Playwright's Chromium 147 did not reproduce that problem.

For real-model evidence, use the bundled `resources/skills/kimchi-tmux/SKILL.md`, an isolated HOME/tmux server and `KIMCHI_BINARY` pointing at this checkout's binary. Capture actual output, export it, open the file offline, test pause/seek/speed/resize, and compare terminal text placement at known times. Keep raw artifacts and temporary credentials out of Git; remove test credentials when done.
