# Agent Link — Linux (user service)

First installable Linux package for the Sage Link device gateway. It runs the
same `device-gateway` bundle as the macOS/Windows gateways under
`systemd --user`, so no root is required.

## Build the tarball

```sh
sh agent-link-linux/packaging/build.sh [--out DIR]
```

Produces `agent-link-<version>-linux.tar.gz` containing the gateway bundle, the `cli-bridge` agent
runtime (`AgentWorkersCode/cli-bridge/host.mjs`, override with
`WORKER_BRIDGE=/path/host.mjs`), installer, unit template, Claude hooks,
the pinned Linux x86_64 Node.js 24.22.3 runtime and its license, and a
`release-manifest.json` with per-file SHA-256. The build checks the
runtime archive against a pinned digest. Set `AGENT_LINK_LINUX_NODE_ARCHIVE`
to build with a cached copy of that same archive.

Release builds set `AGENT_LINK_PRODUCT_VERSION` and `AGENT_LINK_BUILD_NUMBER`
from the same release inputs as the Mac package. The archive name uses the
product version, and the manifest records both values. Development builds
default to the `device-gateway` package version and build number `1`.

To provision the Linux update channel in the bridge package, pass
`AGENT_LINK_UPDATE_TUF_ROOT`, `AGENT_LINK_UPDATE_TUF_METADATA_URL`,
`AGENT_LINK_UPDATE_TUF_TARGET_URL` and `AGENT_LINK_UPDATE_TUF_RECORD_PATH`.
`AGENT_LINK_UPDATE_TUF_CHANNEL` defaults to `stable`. The installation
keeps the initial channel settings and the TUF cache across updates.

## Install / upgrade

```sh
mkdir -p agent-link-linux
tar -xzf agent-link-<version>-linux.tar.gz -C agent-link-linux
cd agent-link-linux
sh install.sh
```

- Requires Ubuntu 24.04 x86_64 and a `systemd --user` session. The installer
  and service use the bundled Node. On headless machines run
  `loginctl enable-linger $USER` once so the service survives logout.
- First install writes `~/.config/agent-link/env` (mode 600) with generated
  owner tokens and kernel-probed free ports, then enables and starts
  `agent-link.service`.
- Run the installer from an unpacked release you trust. It checks the
  manifest and stages the program in `program/versions/<build>` under the
  prefix. Existing credentials and state stay in their original directories.
- A running gateway must confirm that its workers are safe to stop. The
  installer snapshots state, atomically selects the candidate and waits
  for its listeners to start before admitting work. A failed startup
  restores the previous program and its state. Rerunning the installer
  recovers an interrupted switch before attempting another installation.
- `DEVICE_GATEWAY_BIND` defaults to `0.0.0.0` so phones on the LAN can reach
  the gateway; use `--bind` to pin an interface. Owner and hooks surfaces stay
  loopback-only.

## Automatic updates

An installation with a configured channel enables `agent-link-update.timer`.
It checks the channel daily with a randomized delay. When the systemd user manager
stops at logout, the next logged-in session resumes scheduled checks.

The updater downloads Linux targets for Ubuntu 24.04 x86_64. Its signed
release record must include `rollout` with `cohortSeed` and `percentage`,
plus `withdrawnBuilds` containing builds unavailable for installation or
rollback. Withdrawals already verified are kept locally. A higher signed
build can repair a withdrawn current build through the same updater. If
candidate startup fails, the installer restores the original data and keeps
the withdrawn build stopped. A subsequent check can install a newer repair.
To request repair immediately on a stopped installation, start
`agent-link-update.service`. Automatic repairs still respect the installation
window and the safe stop point when the gateway is running.

Use `systemctl --user disable --now agent-link-update.timer` to disable
automatic checks. To turn them back on, run
`systemctl --user enable --now "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-link-update.timer"`.
Use `systemctl --user start agent-link-update.service`
for an immediate check. Both paths require the gateway to reach a safe stop point.
To limit automatic installation to local hours, create
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-link/update-policy.json` with
`{"start":"23:30","end":"02:00"}`. Remove that file to allow installation at any time.
Automatic checks can download outside the window and retain one verified archive
while waiting for the configured hours or for active work to finish. The updater
checks fresh signed metadata before reusing the archive and before stopping the gateway.
The updater bundles an Undici dispatcher that handles download servers closing
HTTP connections after each response.
See the schedule in `PREFIX/updates/automatic.json` and the logs in
`journalctl --user -u agent-link-update-scheduled.service -u agent-link-update.service`.
On older bridge installations, rerun the installer from this verified package
to refresh the scheduler and its Node runtime. The installer retains the
existing channel trust, rollout cohort and timer enablement.

## What the phone can do (free LAN tier)

The gateway runs `DEVICE_GATEWAY_PROFILE=LOCAL_CLI`, the same profile the
macOS Agent Link app uses:

- **Discovery**: the gateway answers mDNS `_agentlink._tcp` on LAN interfaces;
  Android/iOS Control apps list it as a discovered host.
- **Pairing**: a discovered phone submits a `discovery` pairing request that
  stays PENDING until the owner approves it on this machine (owner API, see
  below). Sealed invite links auto-approve.
- **Agents**: `CLI_BRIDGE_HOST`/`CLI_BRIDGE_PROJECT` make the gateway spawn
  one `cli-bridge` worker per detected CLI — `claude`, `codex` or `pi` on
  PATH — inside the project directory (`--project`, default
  `~/agent-link-projects`). Each bridge registers itself as a worker-local
  backend, so the phone sees real projects/engines, can preflight, launch,
  observe, message and stop tasks. Bridges are boot-scoped: after a service
  restart the supervisor respawns and re-registers them.
- **Scope**: paired devices get launch scopes for every project × engine the
  catalog reports. Member services use separate authorization.

## Member cloud task authorization

From an installed package, run `sh install.sh member login`, open the
printed verification page on a trusted phone or computer and approve the
device code. The command waits for confirmation and the user service keeps
the private session and refreshes its access token. `member status` shows
the local sign-in state. `member logout` signs out locally and requests
revocation of this device if the member service is reachable. These commands
leave the local gateway running.

For a Linux host provisioned externally with an `agent-link` member-device session,
set `DEVICE_GATEWAY_CLOUD_OWNER_GRANTS=1`, `DEVICE_GATEWAY_CLOUD_ORIGIN` to
its HTTPS member origin and `DEVICE_GATEWAY_CLOUD_SESSION` to the absolute
path of its provisioned `PAC_RELAY_*` session file in the user service
environment. The session file must belong to the service user and be
private. Keep its credentials out of the package and the gateway env file.
Restart the service after configuring these inputs.

The authenticated loopback owner API `GET /api/v2/personal-access/cloud-launch-grant`
lists local native targets and the current revision. `PUT` accepts
`expectedRevision`, `launchScopes`, `controls`, and `approvals`.
Each selected scope contains the target's `backendStoreId` (its `backendId`
from the list), `projectId` and `engineId`. Use an empty `launchScopes`
array to revoke the grant. Changes take effect without restarting and
existing task receipts remain recoverable. A local-only installation leaves
cloud configuration unset and skips member sign-in. Cloud dispatch requires
a separate owner grant for each project and engine.

## Local scheduled tasks

Under the authenticated loopback owner API, use
`GET /api/v2/personal-access/local-schedules` to list rules or `POST` to
create one. Use a project and engine advertised under `linkTargets` in
`GET /api/v2/personal-access/capabilities`. The request's target uses
`backendStoreId` from the catalog's `backendId`.

```json
{
  "requestKey": "weekday-scan",
  "target": {
    "backendStoreId": "worker-store",
    "projectId": "project",
    "engineId": "codex"
  },
  "instruction": "Summarize recent changes in this project.",
  "timezone": "Asia/Shanghai",
  "schedule": {"kind": "weekly", "dayOfWeek": 0, "timeOfDay": "09:00"},
  "offlinePolicy": "queue",
  "dstPolicy": "fire",
  "catchUpSeconds": 3600
}
```

`daily` takes `timeOfDay`, `weekly` also takes Monday-based `dayOfWeek`,
and `interval` takes `everySeconds` (300 through 2,592,000). The default
catch-up window is one hour. `queue` lets a late occurrence wait for the
same local Worker until then. `skip` skips a trigger when Link or its
Worker was unavailable. A repeated local hour fires once. `dstPolicy:
"skip"` skips an invalid spring-forward time, while `fire` moves it
forward by the offset change.

For one rule, use `GET /local-schedules/{ruleId}`,
`PUT /local-schedules/{ruleId}` with changed fields and
`expectedRevision` (including `paused` for pause/resume), or
`POST /local-schedules/{ruleId}/remove` with `expectedRevision`. Paths
are relative to the owner API prefix above. Its `GET .../occurrences`
returns the latest 100 triggers with their local task IDs and states.
An interrupted submission stays `submitting` until its original Worker
receipt can be read. These rules are installed and executed on this Link
and use its existing local SQLite state.

## Owner operations

Owner API is loopback-only at `http://127.0.0.1:$OWNER_PORT` with
`Authorization: Bearer $DEVICE_GATEWAY_OWNER_TOKEN` +
`x-client-session: $DEVICE_GATEWAY_OWNER_CLIENT_TOKEN` (both in the env
file):

- `GET /api/v2/personal-access/pairing-requests` — list pending pairings
- `POST /api/v2/personal-access/pairing-requests/{id}/decisions` — approve/deny
- `POST /api/v2/personal-access/worker-invitations` — mint a one-shot worker
  registration secret (`{requestId}`)
- `POST /api/v2/personal-access/worker-registrations` — register a
  worker-local source directly (`{connectionId,url,token,displayName}`)
- `GET /api/v2/personal-access/link-state` — service/link health

## Uninstall

```sh
sh uninstall.sh           # keeps env + data for reinstall
sh uninstall.sh --purge   # removes everything
```

## Verify

Preview a support report using the verified archive or the installed slot.
Pass the same `--prefix` used at installation if you selected a custom one.

```sh
sh install.sh diagnostics
sh "${XDG_DATA_HOME:-$HOME/.local/share}/agent-link/program/current/install.sh" diagnostics --output agent-link-report.json
```

The export creates a new private JSON file. It contains the local OS and
architecture, build numbers, user service state, update channel and schedule,
the last recorded install outcome and an operation ID when available.
`sources` shows whether each read returned usable data. A report generated
before installation or with the user service stopped can still be used.
The command reads only the selected product metadata and service status.
It performs no network requests or upload. [systemctl machine-readable state](https://www.freedesktop.org/software/systemd/man/256/systemctl.html)

Rerun the verified installer on an older bridge installation to refresh its
fixed updater. The new updater records subsequent installation and rollback
receipts. The report can also show the failed build from an older updater.

```sh
systemctl --user status agent-link.service
journalctl --user -u agent-link.service -f
```
