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
UPDATE_TOOLS="$REPO/packages/agent-link-update"
WORKERS_REPO="${WORKERS_REPO:-$(CDPATH= cd -- "$REPO/../AgentWorkersCode" 2>/dev/null && pwd || true)}"
WORKER_BRIDGE="${WORKER_BRIDGE:-$WORKERS_REPO/cli-bridge/host.mjs}"
OUT="$REPO/.local/agent-link-linux-release"
NODE_VERSION=24.22.3
NODE_DIST="node-v$NODE_VERSION-linux-x64"
NODE_SHA256=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb

while [ $# -gt 0 ]; do
    case "$1" in
        --out) OUT=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

VERSION=${AGENT_LINK_PRODUCT_VERSION:-$(node -p 'require(process.argv[1]).version' "$GATEWAY/package.json")}
BUILD_NUMBER=${AGENT_LINK_BUILD_NUMBER:-1}
node - "$VERSION" "$BUILD_NUMBER" <<'EOF'
const [version, buildNumber] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  console.error('AGENT_LINK_PRODUCT_VERSION must be a three-part product version.');
  process.exit(2);
}
if (!/^[1-9]\d*$/.test(buildNumber) || !Number.isSafeInteger(Number(buildNumber))) {
  console.error('AGENT_LINK_BUILD_NUMBER must be a positive decimal integer.');
  process.exit(2);
}
EOF

[ -d "$OUT" ] && { echo "choose a fresh output directory: $OUT" >&2; exit 1; }
runtime_tmp=$(mktemp -d)
trap 'rm -rf "$runtime_tmp"' EXIT
runtime_archive=${AGENT_LINK_LINUX_NODE_ARCHIVE:-$runtime_tmp/$NODE_DIST.tar.xz}
if [ -z "${AGENT_LINK_LINUX_NODE_ARCHIVE:-}" ]; then
    curl -fsSL --retry 2 "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.xz" -o "$runtime_archive"
fi
node - "$runtime_archive" "$NODE_SHA256" <<'EOF'
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const [archive, expected] = process.argv.slice(2);
(async () => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Linux Node archive checksum mismatch');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
EOF
tar -xJf "$runtime_archive" -C "$runtime_tmp" "$NODE_DIST/bin/node" "$NODE_DIST/LICENSE"

mkdir -p "$OUT/payload/hooks" "$OUT/payload/runtime" "$OUT/payload/systemd"
mkdir -p "$OUT/payload/bootstrap"
install -m 755 "$runtime_tmp/$NODE_DIST/bin/node" "$OUT/payload/runtime/node"
install -m 644 "$runtime_tmp/$NODE_DIST/LICENSE" "$OUT/payload/runtime/node-LICENSE"

npm --prefix "$GATEWAY" run build
cp "$GATEWAY/dist/device-gateway.mjs" "$OUT/payload/device-gateway.mjs"
# Agent runtime: the cli-bridge worker-local host (same source the macOS
# Agent Link bundle ships). Override with WORKER_BRIDGE=/path/host.mjs.
[ -f "$WORKER_BRIDGE" ] || { echo "cli-bridge host.mjs not found: $WORKER_BRIDGE" >&2; echo "set WORKER_BRIDGE or check out AgentWorkersCode next to this repo" >&2; exit 1; }
cp "$WORKER_BRIDGE" "$OUT/payload/cli-bridge.mjs"
if [ -d "$(dirname "$WORKER_BRIDGE")/adapters" ]; then
    cp -R "$(dirname "$WORKER_BRIDGE")/adapters" "$OUT/payload/adapters"
fi
cp "$GATEWAY/hooks/agent_pre_tool.py" "$GATEWAY/hooks/install.py" "$OUT/payload/hooks/"
cp "$PRODUCT/install.sh" "$PRODUCT/uninstall.sh" "$OUT/payload/"
cp "$PRODUCT/install-transaction.mjs" "$PRODUCT/configure-update.mjs" \
    "$PRODUCT/launch.sh" "$PRODUCT/slots.mjs" "$OUT/payload/"
"$GATEWAY/node_modules/.bin/esbuild" "$PRODUCT/install.mjs" \
    --bundle --platform=node --format=esm --target=node24 --outfile="$OUT/payload/install.mjs"
cp "$PRODUCT/systemd/agent-link.service" "$PRODUCT/systemd/agent-link-update.service" \
    "$PRODUCT/systemd/agent-link-update.timer" "$OUT/payload/systemd/"
cp "$PRODUCT/README.md" "$OUT/payload/README.md" 2>/dev/null || true
chmod +x "$OUT/payload/install.sh" "$OUT/payload/uninstall.sh" "$OUT/payload/launch.sh"

npm --prefix "$UPDATE_TOOLS" ci --ignore-scripts --no-audit
"$GATEWAY/node_modules/.bin/esbuild" "$UPDATE_TOOLS/src/linux-updater.mjs" \
    --bundle --platform=node --format=cjs --target=node24 --minify --outfile="$OUT/payload/bootstrap/update.cjs"
node - "$UPDATE_TOOLS" "$OUT/payload/bootstrap/THIRD-PARTY-NOTICES.txt" <<'EOF'
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [tools, out] = process.argv.slice(2);
const { packages } = JSON.parse(readFileSync(join(tools, 'package-lock.json'), 'utf8'));
const notices = [];
for (const [name, { version, dev }] of Object.entries(packages)) {
  if (!name || dev) continue;
  const dir = join(tools, name);
  for (const file of readdirSync(dir).filter(file => /^(?:licen[cs]e|copying|notice)(?:[.-].*|$)/i.test(file))) {
    notices.push(`${name.slice('node_modules/'.length)} ${version} (${file})\n${readFileSync(join(dir, file), 'utf8')}`);
  }
}
writeFileSync(out, notices.join('\n\n'));
EOF

tuf_root=${AGENT_LINK_UPDATE_TUF_ROOT:-}
tuf_metadata=${AGENT_LINK_UPDATE_TUF_METADATA_URL:-}
tuf_targets=${AGENT_LINK_UPDATE_TUF_TARGET_URL:-}
tuf_record=${AGENT_LINK_UPDATE_TUF_RECORD_PATH:-}
tuf_channel=${AGENT_LINK_UPDATE_TUF_CHANNEL:-stable}
if [ -n "$tuf_root$tuf_metadata$tuf_targets$tuf_record" ]; then
    [ -f "$tuf_root" ] && [ -n "$tuf_metadata" ] && [ -n "$tuf_targets" ] && [ -n "$tuf_record" ] \
        || { echo 'The Linux update channel needs a pinned root, both repository URLs and a release record path.' >&2; exit 2; }
    node - "$OUT/payload/bootstrap/trust.json" "$tuf_metadata" "$tuf_targets" "$tuf_record" "$tuf_channel" <<'EOF'
const { writeFileSync } = require('node:fs');
const [path, metadataBaseUrl, targetBaseUrl, releaseRecordPath, channel] = process.argv.slice(2);
for (const value of [metadataBaseUrl, targetBaseUrl]) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid TUF repository URL');
}
if (!['stable', 'preview'].includes(channel) ||
    !/^(?:[A-Za-z0-9_-][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._+-]*$/.test(releaseRecordPath)) {
  throw new Error('Invalid TUF channel or record path');
}
writeFileSync(path, JSON.stringify({ metadataBaseUrl, targetBaseUrl, releaseRecordPath, channel }) + '\n');
EOF
    cp "$tuf_root" "$OUT/payload/bootstrap/root.json"
fi

GATEWAY_SHA=$(git -C "$REPO" rev-parse HEAD)
DIRTY=$(git -C "$REPO" status --porcelain -- device-gateway agent-link-linux | wc -l | tr -d ' ')
WORKER_DIR=$(dirname "$WORKER_BRIDGE")
WORKER_SHA=$(git -C "$WORKER_DIR" rev-parse HEAD 2>/dev/null || true)
WORKER_DIRTY=$(git -C "$WORKER_DIR" status --porcelain -- "$(basename "$WORKER_BRIDGE")" adapters 2>/dev/null | wc -l | tr -d ' ')
node - "$OUT/payload" "$OUT/payload/release-manifest.json" "$VERSION" "$BUILD_NUMBER" "$GATEWAY_SHA" "$DIRTY" "$NODE_VERSION" "$WORKER_SHA" "$WORKER_DIRTY" <<'EOF'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [root, out, version, buildNumber, sha, dirty, nodeVersion, workerSha, workerDirty] = process.argv.slice(2);
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
  schemaVersion: 1, product: 'Agent Link', version, buildNumber: Number(buildNumber),
  build: 'linux-user-service', gatewayBaseRevision: sha,
  gatewayWorkingTree: dirty !== '0', platform: 'linux', arch: 'x64', nodeVersion, nodeRequirement: '>=24.18.0',
  workerBaseRevision: workerSha || null, workerWorkingTree: workerSha ? workerDirty !== '0' : null,
  files,
}, null, 2) + '\n');
EOF

COPYFILE_DISABLE=1 tar --format=ustar -czf "$OUT/agent-link-$VERSION-linux.tar.gz" -C "$OUT/payload" .
echo "built $OUT/agent-link-$VERSION-linux.tar.gz"
echo "payload at $OUT/payload (release-manifest.json included)"
