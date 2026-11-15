#!/bin/sh
# Build the Agent Link Linux tarball: device-gateway bundle + installer +
# systemd unit + hooks + release manifest. Run on the dev machine:
#
#   sh agent-link-linux/packaging/build.sh [--out DIR]
#
# Produces agent-link-<version>-linux.tar.gz under --out (default
# .local/agent-link-linux-release).
set -eu

PRODUCT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO=$(CDPATH= cd -- "$PRODUCT/.." && pwd)
GATEWAY="$REPO/device-gateway"
WORKERS_REPO="${WORKERS_REPO:-$(CDPATH= cd -- "$REPO/../AgentWorkersCode" 2>/dev/null && pwd || true)}"
WORKER_BRIDGE="${WORKER_BRIDGE:-$WORKERS_REPO/cli-bridge/host.mjs}"
OUT="$REPO/.local/agent-link-linux-release"

while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

VERSION=$(node -e 'console.log(require(process.argv[1]).version)' "$GATEWAY/package.json")
[ -n "$VERSION" ] || { echo "could not read gateway version" >&2; exit 1; }

[ -d "$OUT" ] && { echo "choose a fresh output directory: $OUT" >&2; exit 1; }
mkdir -p "$OUT/payload/hooks" "$OUT/payload/systemd"

npm --prefix "$GATEWAY" run build
cp "$GATEWAY/dist/device-gateway.mjs" "$OUT/payload/device-gateway.mjs"
# Agent runtime: the cli-bridge worker-local host (same source the macOS
# Agent Link bundle ships). Override with WORKER_BRIDGE=/path/host.mjs.
[ -f "$WORKER_BRIDGE" ] || { echo "cli-bridge host.mjs not found: $WORKER_BRIDGE" >&2; echo "set WORKER_BRIDGE or check out AgentWorkersCode next to this repo" >&2; exit 1; }
cp "$WORKER_BRIDGE" "$OUT/payload/cli-bridge.mjs"
cp "$GATEWAY/hooks/agent_pre_tool.py" "$GATEWAY/hooks/install.py" "$OUT/payload/hooks/"
cp "$PRODUCT/install.sh" "$PRODUCT/uninstall.sh" "$OUT/payload/"
cp "$PRODUCT/systemd/agent-link.service" "$OUT/payload/systemd/agent-link.service"
cp "$PRODUCT/README.md" "$OUT/payload/README.md" 2>/dev/null || true
chmod +x "$OUT/payload/install.sh" "$OUT/payload/uninstall.sh"

GATEWAY_SHA=$(git -C "$REPO" rev-parse HEAD)
DIRTY=$(git -C "$REPO" status --porcelain -- device-gateway agent-link-linux | wc -l | tr -d ' ')
node - "$OUT/payload" "$OUT/payload/release-manifest.json" "$VERSION" "$GATEWAY_SHA" "$DIRTY" <<'EOF'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [root, out, version, sha, dirty] = process.argv.slice(2);
const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name !== 'release-manifest.json') files.push({
      path: path.relative(root, p).split(path.sep).join('/'),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    });
  }
};
walk(root);
fs.writeFileSync(out, JSON.stringify({
  schemaVersion: 1, product: 'Agent Link', version,
  build: 'linux-user-service', gatewayBaseRevision: sha,
  gatewayWorkingTree: dirty !== '0', nodeRequirement: '>=24.18.0',
  files,
}, null, 2) + '\n');
EOF

tar -czf "$OUT/agent-link-$VERSION-linux.tar.gz" -C "$OUT/payload" .
echo "built $OUT/agent-link-$VERSION-linux.tar.gz"
echo "payload at $OUT/payload (release-manifest.json included)"
