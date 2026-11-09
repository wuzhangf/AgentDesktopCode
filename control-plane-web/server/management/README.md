# Personal management gateway (`/api/personal/v1`)

PAE P5 package — task sheet §8; contract freeze `p0-contract-freeze.md` §4 +
§5.1 addendum; design `acs-worker-project-environment-detailed-design-2026-10-18.md`
§10.2/§11/§12.

This directory implements the personal management BFF for Desktop/Web. It is
the **third channel** beside read-only `/api/v2` observation and the
`/api/worker` lab BFF; it never wildcard-proxies either of them.

## Files

| File | Role |
|---|---|
| `personal-control.ts` | `createPersonalGateway(options)` — loopback HTTP server, Host allow-list, `x-personal-control`/`x-personal-tab`/`personal_control` cookie session guards, 8-tab/20-min sessions, ≤1 MiB bodies, static `dist` serving. Returns `{server, store, hub, service, controlPlaneId, instanceId, setReportProvider, setActionRunner, registerTask, close}`. |
| `personal-install.ts` | Install-side connections and optional report/observation wiring, mounted once by `management-main.ts`. |
| `tasks.ts` / `task-metrics.ts` | Ordinary ACS task launch/reconciliation/read projections; optional exact-run observation reader. |
| `service.ts` | Route handlers for the 19 frozen routes + the §5.1 `POST /environment-operations/{id}/inputs` continuation. Envelope `{meta:{source,instance,controlPlaneId,observedAt,revision,supportedActions,reasonCodes}, data}` on success; `{error:{code,message,retryable,requestId}}` on failure. |
| `upstream.ts` | Fixed leaf adapters: `ServiceClient` for `CORE_LOCAL`/`ACS_DIRECT` connections (projects, session-preflight, build-plan, environment features, MCP, attention, deliveries, client-sessions); `WorkerEnvClient` for the `DAEMON` `/env/v1` channel (freeze §3). `connectionCapabilities` keeps the per-kind honesty rule — prepare/bound-execution are advertised only when the managed channel is actually configured. |
| `registry-store.ts` | `ManagementStore` over `node:sqlite` `DatabaseSync` (writable, WAL). Tables: `management_meta`, `connections`, `projects`, `project_environments`, `tasks`, `task_actions`, `request_ledger`, `env_operations`, `operation_events`, `readiness_facts`, `action_trials`, `management_schema_migrations`. `observations.db` is never opened here. |
| `migrations.ts` | Migration runner + `registerManagementMigration` registry seam. |
| `canonical.ts` | Freeze §0 canonical JSON (code-point key order, no whitespace) + `sha256:` digests. |
| `errors.ts` | `ManagementError` → frozen `{error}` body encoding. |

## Idempotency (task §8.5)

Every write carries `requestKey` (+ `expectedRevision?`). `request_ledger`
rows are inserted **before** any external dispatch; replayed key+body returns
the recorded response verbatim, same key + different body is
`409 IDEMPOTENCY_CONFLICT`. A `PENDING` row (crash mid-flight) resumes the
original dispatch — the upstream `/env/v1` channel dedups on the same
forwarded `requestKey`, so a browser refresh/retry can never double-create an
operation.

## Capability honesty (task §8.4)

- `CORE_LOCAL`: ordinary ACS sessions and reads; no managed-environment rights.
- `ACS_DIRECT`: ordinary ACS sessions and reads; no Docker install right.
- `DAEMON`: `/env/v1` managed channel — real prepare/cleanup/retire,
  `inspect`, environment list. Only this kind can advertise
  `projectEnvironmentPrepareV1` / `environmentBoundExecutionV1`;
  `adaptiveActionV1` additionally requires a registered `AdaptiveActionRunner`.

## Offline rule (task §8.6)

Observations persist as `readiness_facts` rows with `observed_at` + `source`.
When an upstream call fails, stored facts are re-served with their original
timestamps and `meta.reasonCodes` carries `BACKEND_UNAVAILABLE`; nothing is
auto-marked FAILED. Operation FAILED/CANCELED states are written only when
the upstream writer reports them or the gateway proved the stop locally.

## P7 seam — report provider + migration namespace

- `server/management/reports/**` is P7-owned; do not create it here.
- P7 registers its provider via `gateway.setReportProvider(...)` (or the
  `reportProvider` option). With no provider, `GET /reports` returns an empty
  list with `meta.reasonCodes = ['REPORT_PROVIDER_NOT_CONFIGURED']` and
  `POST /reports` fails `503 REPORT_PROVIDER_NOT_CONFIGURED` — no fake
  reports.
- P7 ships table definitions by calling `registerManagementMigration` from
  `server/management/reports/` module init **before** the store opens, or by
  passing `extraMigrations` into `createPersonalGateway`. Convention:
  namespace `p7-reports`, versions ≥ 100 (P5 core occupies 1..99). Versions
  are globally unique and applied in ascending order, each in an IMMEDIATE
  transaction recorded in `management_schema_migrations` with a source
  checksum (drift is surfaced via `runMigrations().drift`, applied rows never
  re-run).

## P8 assembly notes (root wiring is P8's)

- `management-main.ts` mounts `gateway.handleRequest` before body parsing.
  One loopback listener (default `8860`) serves Worker management, personal tasks and HTML.
- `pnpm management:build` builds the SPA, `management-server.mjs` and its reader `worker.mjs`.
  `pnpm mgmt:serve` / `pnpm management:serve` run the same artifact. The old standalone personal listener is removed.
- tsconfig `include` covers `server/management/**/*.ts` (added by this
  package).
- Browser client: send `x-personal-control: 1`, `x-personal-tab: <id>` on
  every call; the `personal_control` cookie is set on first response.
- Upstream credentials: provision `ConnectionProvision.tokenRef` /
  `envTokenRef` as `env:VAR_NAME` refs; values resolve via
  `options.secretResolver` (default reads `process.env`), loaded by the
  central env helper — never stored or rendered.

## Mobile remote inbox owner controls

The desktop owner surface exposes the fixed ntfy controls below through the
same `/api/personal/v1/device-access/:connection` guard. ACS is authoritative
for provider configuration, device routes, grant revisions and delivery state;
the Business gateway does not create a second provider registry or accept an
ntfy URL, topic, publish token, or credential reference from the browser.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/notification-provider` | Safe provider state (`providerRef`, state, endpoint origin, configured flag and redacted errors). |
| `PUT` | `/notification-provider` | Owner-only enable/disable with `{requestKey, enabled, expectedRevision?}`. |
| `GET` | `/notification-routes` | Per-device route state projection from ACS. |
| `GET` / `PUT` | `/devices/:device/notification-route` | Read or toggle one active device route; PUT accepts only `{requestKey, enabled, expectedGrantRevision?}`. |
| `GET` | `/devices/:device/notification-subscription` | Protected subscription instructions/material for an already active device. It can contain a read credential needed by the ntfy client, never a publish credential. |

The subscription response is displayed only after the owner has enabled that
device route and is not persisted by the browser. If ACS cannot generate a
subscription credential it returns an explicit unavailable/configuration state
and instructions; the owner page does not invent a topic or fall back to a
secret-bearing deep link. Existing HTTPS origin, certificate SAN, validity and
loopback diagnostics remain independent of notification availability.

## Personal Web task execution (2026-10-19)

`personal.html#/tasks` selects an ACS project by name, automatically registers its reference,
checks the real source preflight, creates an isolated `CLEAN_HEAD` session and sends the first
message. Source Session/Run remains authoritative. New fixed operations are declared in
`protocol/src/personal.ts`; task DTOs are in `personal-task.ts`.

`tasks.launch_json` / `request_key` are migration 2 (`p5-core`); existing rows remain readable.
The task and PENDING request are committed together before source mutation. Frozen create and
message bodies use stable child keys. A lost reply leaves PENDING; POST the same body/key to
reconcile. GET reads never create sessions or send messages. Errors after possible dispatch
are not proof of rejection. The detail page retains timestamped observations during an outage.

Required installation variables are `PERSONAL_ACS_URL` and the existing `PERSONAL_ACS_TOKEN`
secret reference. Load them with `. D:/project/env/env.ps1`; never create project secret files.
`PERSONAL_CONSOLE_PORT/ROOT/DIST` configure the single listener and Worker management root.
`PERSONAL_DATA_DIR` defaults to `<root>/personal`; point it to the old personal data directory
when continuing an existing registry. Do not run two listeners on one registry.

Observation is optional. `PERSONAL_OBSERVATION_SOURCE_ID` must explicitly name a LIVE source
in the existing source whitelist (`OBS_DB` override uses `env-obs-db`), with optional
`PERSONAL_OBSERVATION_SCOPE_ID` (default `local`). Binding identity is frozen per task.
Snapshot/demo/default analysis sources are never used implicitly. Query failure or missing
binding yields null metrics, not zero. Reported and estimated tokens and cost source/currency
facets remain separate. No model catalog process-wide counters are used as task usage.
`PERSONAL_REPORTS_ENABLED=0` disables the optional reports mount; Docker/daemon/reports/
observation do not gate ordinary ACS execution.

Validation tools: `verification/personal-web/README.md`.
