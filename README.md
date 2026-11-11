# AgentDesktopCode

Computer-side Agent control products (open source).

- `device-gateway/` — lightweight gateway that exposes the personal-agent control
  surface (`/personal/v1`) to paired phones, hosts the worker catalog, relay
  connector, pairing and authorization.
- `codeagent-desktop/` — Electron desktop workbench (Windows primary): sessions,
  approvals, personal-access panel, and the shell that can embed the gateway.
- `control-plane-web/` — web control plane / management UI.
- `client-access/` — client-access contract CLI and fixtures.
- `packages/personal-gateway-core/` — shared gateway core used by control-plane-web.
- `contracts/` — protocol contract snapshots (`agent-code`, `personal-agent-access`).
- `service-dependency.lock.json` — pinned service artifact coordinates consumed by
  `codeagent-desktop/scripts/generate-protocol.mjs`.

Each app is self-contained (own `pnpm-workspace.yaml` / lockfile). See each app's
README for build and test commands.

Secrets: none belong in this repo. Provide `MODEL_*` / `WORKER_LOCAL_TOKEN` and
service credentials via environment or your local credential store.
