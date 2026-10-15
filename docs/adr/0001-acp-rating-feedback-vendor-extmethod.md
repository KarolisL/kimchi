# Response rating over ACP: vendor extMethod with client-rendered UX

The TUI rating flow (rate the settled response: sentiment + optional reason → transcript entry + telemetry) needed an ACP equivalent. We decided to expose it as a single session-scoped inbound vendor extMethod, `_kimchi.dev/feedback` (action-discriminated; first action `rate_response` with `{ sentiment, reason? }`), advertised in `_meta["kimchi.dev"]`, returning `{ status: "recorded" }`.

Decided this way because the alternatives each break an invariant:

- **ACP elicitation (`unstable_createElicitation`)** — rejected: agent-initiated and turn-blocking, but a rating happens *after* the turn settles and is client-initiated; it is also an *unstable* ACP feature, and the client (Kimchi Studio) renders its own native dialog anyway (Figma "Kimchi Surfaces" design: Your rating / Why? / Anything else?).
- **Available-commands / prompt rewrite** — rejected: commands rewrite the next user prompt, which feeds the model; ratings must never enter the model's context (same reason the TUI stores them as custom entries, not messages).
- **Agent-pushed invitation notifications** — rejected for v1: the client renders the affordance and reason lists from its own knowledge (client-driven); the server only validates the rating window and rejects invalid submissions with distinct errors (`a prompt is already in progress` vs `no settled response to rate`).
- **A two-field record (reason + message)** — rejected: the TUI record is a single `reason` string (predefined or custom) whose predefined-vs-custom tag drives downstream freeform filtering in telemetry. The client merges its two dialog fields into one string per that model; neither transcript entry nor `trackFeedback` schema changes.

Two consequences worth remembering:

- `routingModelId` (the routed pick, e.g. `auto-beta` → `glm-5.3`) is always computed **server-side** from the tracked rating window state, never accepted from client input.
- The ACP window arms only for turns that resolve `end_turn` (cancelled/errored runs don't arm) — deliberately stricter than the TUI, which arms on any `agent_settled`.

Scope note: model-switch feedback stays TUI-only for now; the extMethod's action discriminator leaves room for it later without a wire break.

Upstream check (2026-02-27, `.kimchi/docs/upstream-feedback-check.md`): pi-mono 0.85.1, the pi.dev catalog, and the ACP spec (SDK 0.19.2) ship no feedback/rating capability — this is new, non-duplicative work on the ext surface the spec sanctions for vendor extensions.
