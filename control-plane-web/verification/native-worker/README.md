# Native Worker consumer acceptance

This runs the same `PersonalTasks` / `NativeTasks` consumer used by the personal web console against a separately started Pi TypeScript or Codex Rust Worker. It does not create an ACS session or implement a second execution authority. Start the host with its own state, project copy, loopback port and bearer token first.

From `apps/control-plane-web`, load credentials through the central helper and provide the selected host token by environment reference:

```powershell
. D:\project\env\env.ps1
$env:NWF_HOST_URL = 'http://127.0.0.1:<isolated-port>'
$env:NWF_HOST_TOKEN = & D:\project\env\env.ps1 -Get <registered-host-token-key>
$env:NWF_ENGINE = 'pi' # or codex
$env:NWF_CONSUMER_OUT = '<new-isolated-evidence-directory>'
npm run worker:native-smoke
```

`NWF_SOURCE_PROJECT` optionally chooses a source project alias. Without it the first advertised project is used. The expected model binding is `deepseek-v4.1-flash`; `NWF_EXPECT_MODEL` may explicitly select a different acceptance target. `NWF_CONSUMER_TIMEOUT_MS` controls each model response deadline (default 180000, maximum 900000). The evidence directory must be new for each run because it contains the BFF's own durable registry. No credentials are persisted.

The test verifies authenticated `worker-host/1` discovery, source identity and engine version, preflight, a real file and public response, same-session follow-up, source stop and quiescence, artifact bytes and SHA-256, events, and metrics with unknown cost preserved. It drops the successful create and follow-up HTTP replies, then verifies original-key GET reconciliation with exactly one POST for each intent. The changed-body replay must conflict. Cleanup can stop only the task created by this run.

Codex command approvals are answered only for the original native question guards, exact owned workspace, and the exact PowerShell scripts issued by this fixture to write or read `native-smoke.txt`. Other approvals fail the test without sending a response. No session-wide command policy is granted.

`evidence.json` records the actual manifest, source binding, honest capability states and observed results. A failure does not qualify the host or platform. This acceptance covers the native ordinary compatibility path; advanced pause, checkpoint recovery, collaboration and enterprise stage qualification remain separate scenarios.

Installed legacy Java ordinary sources still use `/local/v1` when the manifest endpoint returns 404. A present incompatible manifest, denied discovery, malformed capabilities, changed authority/store or engine version fails closed. Discovery never enables new UCA actions or changes legacy pause/resume flags.
