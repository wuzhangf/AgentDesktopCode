# Client access reference consumer

`client-access.mjs` is a small transport port for `client-access/1`, usable with browser or Node fetch. It treats source kinds and engine names as display information; it never dispatches by Daily/ACS/Pi/Codex. Trusted connection setup supplies origin, fixed basePath and supported authentication. Additional native engines belong in host adapters.

Products supply a durable `pending.set/get` implementation, scoped to the authenticated connection. `memoryPending` is for deterministic tests only. Pending records contain the frozen operation and locator, never credentials. A dispatched intention is only looked up after failure/restart, including after a 404; it is never automatically posted again. Switching device/principal requires a separate pending store.

Pass a stable `connectionId` from trusted connection setup, representing the device/principal; it participates in cache/pending isolation with origin, profile, store and authorization revision. Source/model names do not participate in routing. The transport permits only the fixed protocol paths and rejects redirects, untrusted HTTP origins, unknown action IDs and unknown input shapes.

Use `connect`, `agents`, `conversations`, `conversation`, `send`, `replies`, `content`, `action`, and `lookup`. Supported action shapes are limited to NONE/TEXT/CONFIRM/SELECT/DECISION. A product must display the full question context before using approval shapes. This port is a reference consumer, not a new CLI/App or a general network proxy.

Run deterministic checks with `node --test apps/client-access/client-access.test.mjs`. The UCA-001 coordination and source acceptance evidence live in EnterpriseDevopsAI.

`trial.mjs` and `actions-trial.mjs` are explicit acceptance drivers over the same port, with temporary file-backed intentions from `test-file-pending.mjs`. They are not an end-user CLI product. The latter restores a fresh consumer instance and queries the original stop receipt. Model tests do not persist provider credentials in these records.
