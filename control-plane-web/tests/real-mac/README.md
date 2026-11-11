# Real Mac Web E2E

This is a separate qualification lane from `tests/e2e` (the L1 fake daemon suite).
It opens the production `personal.html`, selects registered Mac projects, clicks
launch and STOP, and downloads every result through visible buttons. It uses no
`page.route`, injected transport, fake daemon, demo mode, or direct mutation API.
The normal management server's `PERSONAL_WORKER_LOCAL_URL` connection reaches the
locked Swift Host through its production native-task adapter.

Prepare an isolated source snapshot (including the referenced desktop protocol,
service client, and Worker renderer components), keep the original dependency
lock, and run `pnpm mgmt:build` there. Launch its production management bundle
with a dedicated `PERSONAL_CONSOLE_PORT`, `PERSONAL_CONSOLE_ROOT`,
`PERSONAL_DATA_DIR`, `PERSONAL_WORKER_LOCAL_URL`, `WORKER_LOCAL_TOKEN`, and
`PERSONAL_REPORTS_ENABLED=0`. Keep temporary credentials in process memory/env.
Use a dedicated locked Host, registry, state, and Apple Simulator resources.
One project must run the frozen passing Apple test; the second must run the
independent 120-second STOP test. Do not reuse user projects or shared services.

From the snapshot's `apps/control-plane-web` directory:

```sh
MAC_WEB_URL=http://127.0.0.1:MANAGEMENT_PORT \
MAC_WEB_EXPECTED_STORE_ID=HOST_STORE_ID \
MAC_WEB_EXPECTED_WORKER_ID=HOST_WORKER_ID \
MAC_WEB_PROJECT_LABEL=UNIQUE_PASSING_PROJECT_NAME \
MAC_WEB_STOP_PROJECT_LABEL=UNIQUE_STOP_PROJECT_NAME \
MAC_WEB_OUTPUT_DIR=ABSOLUTE_NEW_OUTPUT_DIRECTORY \
MAC_WEB_REPORT_FILE=ABSOLUTE_NEW_REPORT_FILE \
MAC_WEB_EVIDENCE_FILE=ABSOLUTE_NEW_CLIENT_EVIDENCE_FILE \
node node_modules/@playwright/test/cli.js test -c playwright.real-mac.config.ts
```

Set `MAC_WEB_EXPECT_PENDING=1` when the external qualification harness drops the
first Host create response **after real acceptance**. The suite reloads the
pending page and clicks the existing original-request reconciliation control.
The harness must separately verify the Host ledger has exactly two CREATEs and
one STOP, and that original-key recovery never re-dispatched. Its transparent
fault proxy must forward actual production requests; it must not return fixture
API data. Tokens must not be written to config, arguments, or artifacts.

Evidence includes the original source binding and session, every downloaded
artifact SHA-256, the actual Apple verification report (build/install success,
one executed test, passed), aggregate/local/remote STOP facts, a second read of
the original STOP receipt after page reload, and two page screenshots. Playwright
tracing is disabled because it would persist headers/cookies. Evidence JSON
contains no HTTP headers or base64 artifact content. A passing Apple fixture is
an Apple/browser integration qualification, not a new model repair or formal
service deployment qualification. A REQUESTED STOP with RECOVERY_REQUIRED and
`quiescent=false` remains explicitly unresolved; cleanup does not change that.
