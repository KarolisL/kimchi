# Kimchi Harness

The vocabulary for the Kimchi coding harness: the terms that recur across surfaces (TUI and ACP), telemetry, and client integrations.

## Language

**Auto model**:
A virtual model (e.g. `auto`, `auto-beta`) that the Auto router resolves to a concrete model for each turn rather than executing on itself.
_Avoid_: router model, virtual auto

**Routed pick**:
The concrete model the Auto router actually resolved for a given turn (e.g. `auto-beta` → `glm-5.3`). Recorded at settle time; later model switches must not rewrite it.
_Avoid_: resolved model (ambiguous: "resolved" also describes promise settlement)

**Settled response**:
An assistant response whose full run chain — retries, queued follow-ups, compaction — has drained. This is the moment a rating becomes meaningful.
_Avoid_: finished turn, completed response

**Rating**:
A user's explicit verdict on the settled response: `positive` or `negative`, plus an optional reason. Recorded as a custom transcript entry and telemetry; never enters the model's context.
_Avoid_: feedback (overloaded — also names model-switch feedback and permission-denial text), thumbs

**Rating window**:
The interval in which a rating may be submitted. Arms when a response settles, is consumed by exactly one accepted submission, and clears on the next turn start or a session reset.
_Avoid_: invitation (names the TUI's affordance, not the state)

**Predefined reason**:
A rating reason taken from the fixed vocabulary (e.g. "Solved my task", "Auto picked the wrong model"). The Auto-specific entries belong only to ratings whose settled turn ran on the Auto model.
_Avoid_: canned reason, suggested reason

**Custom reason**:
A rating reason the user types themselves; capped at 300 characters. Telemetry tags submissions predefined-vs-custom so freeform text can be filtered downstream.
_Avoid_: freeform reason (kept as the telemetry tag), other

**Model-switch feedback**:
The reason a user gives for switching from the Auto model to a concrete model. A separate concept from Rating: no sentiment, no window, triggered by the switch itself. Currently TUI-only.
_Avoid_: switch rating

**Kimchi Studio**:
The primary ACP client (IDE/desktop app) that renders client-side UX such as the rating dialog and drives the harness over the `kimchi.dev` extMethod/extNotification surface.
_Avoid_: the client (ambiguous — any ACP client qualifies)
