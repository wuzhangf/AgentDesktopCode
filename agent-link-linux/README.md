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
`WORKER_BRIDGE=/path/host.mjs`), installer, unit template, Claude hooks and
a `release-manifest.json` with per-file SHA-256.

Release builds set `AGENT_LINK_PRODUCT_VERSION` and `AGENT_LINK_BUILD_NUMBER`
from the same release inputs as the Mac package. The archive name uses the
product version, and the manifest records both values. Development builds
default to the `device-gateway` package version and build number `1`.

## Install / upgrade

```sh
tar -xzf agent-link-<version>-linux.tar.gz -C agent-link-linux
cd agent-link-linux
sh install.sh                 # or: sh install.sh --prefix /opt/agent-link --bind 0.0.0.0 --project ~/code
```

- Requires `node >= 24.18` on PATH and a `systemd --user` session. On headless
  machines run `loginctl enable-linger $USER` once so the service survives
  logout.
- First install writes `~/.config/agent-link/env` (mode 600) with generated
  owner tokens and kernel-probed free ports, then enables and starts
  `agent-link.service`.
- Re-running over an existing install is an upgrade: payload is replaced,
  env/data are kept; missing LOCAL_CLI profile lines are appended.
- `DEVICE_GATEWAY_BIND` defaults to `0.0.0.0` so phones on the LAN can reach
  the gateway; use `--bind` to pin an interface. Owner and hooks surfaces stay
  loopback-only.

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
  catalog reports; member/relay pairing and commercial entitlements are not
  part of this package (that is the hosted/member deployment's job).

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

```sh
systemctl --user status agent-link.service
journalctl --user -u agent-link.service -f
```
