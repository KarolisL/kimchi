# Native MCP migration

kimchi runs MCP on pi's native engine (pi 1.3's `builtin:mcp`): servers live in `<agentDir>/mcp.json`, projects add or override servers in `.kimchi/mcp.json` (gated by project trust), and the `/mcp` panel, `kimchi mcp login`/`logout`, and the OAuth store are pi's. This page records what changed for users coming from the pi-mcp-adapter era and what the one-shot migration does.

## The one-shot migration

On the first start after the upgrade, adapter-era configs are translated in place (user global + project layers, including legacy `~/.config/mcp/mcp.json`, `.mcp.json`, and `mcp-adapter.json` layers folded in with their precedence):

- `disabled: true` → `enabled: false`, `requestTimeoutMs` → `timeout` (seconds), `directTools: true` → `exposure: "direct"`, `bearerToken`/`bearerTokenEnv` → a static `Authorization` header.
- Adapter-only fields (`toolPrefix`, `lifecycle`, `idleTimeout`, `gateway`, …) and the `settings`/`imports` tiers are dropped and listed in `<agentDir>/mcp-native-migration-report.json`, with a one-time startup notice when something was dropped. `imports` entries should be re-added through the `kimchi agent-discovery` import flows.
- Each rewritten file keeps a `<file>.pre-native-migration.bak` backup next to it (written once, never overwritten) and is chmod 0600.
- Already-native configs are left untouched (no rewrite, no report); the migration is stamped done in `mcp-native-migration.done` and never re-runs. ACP sessions translate the project file of their session directory on demand, recorded in `mcp-native-migration-projects.json`.

## OAuth re-login

The adapter kept OAuth tokens in the macOS keychain; the native engine stores them in `<agentDir>/mcp-auth.json` (0600), keyed per server name + URL. Tokens are deliberately not migrated, so **each OAuth server needs one re-login after the upgrade** — `/mcp` → Sign in, or `kimchi mcp login <server>`. A one-time startup notice lists the affected servers when adapter-era token traces are found. `kimchi mcp forget-grant <server> --json` removes a server's stored grants (including old URLs the native `mcp logout` cannot reach, since it only clears the currently configured URL).

## Dropped adapter features

- The gateway meta-tool and its search-to-direct flow: tools are now first-class `mcp__<server>__<tool>` names, managed through the `/mcp` panel. Pin visibility per tool with `toolExposure`.
- `/mcp` panel pins and other adapter-era panel conveniences: the panel is pi's.
- Idle disconnect: once first used, a server stays connected for the session; disable a server (`enabled: false` or the panel's per-project toggle) to control it.
- Mid-session config additions apply on `/reload` (there is no live file watcher).

## Tool names

Native tool names are `mcp__<server>__<tool>`, with `-` in server names replaced by `_`. Scripts or rules that matched adapter-era names (e.g. `server_tool`) need updating.
