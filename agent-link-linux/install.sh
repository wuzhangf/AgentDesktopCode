#!/bin/sh
# Install (or upgrade) the Agent Link device gateway as a systemd --user
# service. Idempotent: re-running over an existing prefix performs an
# upgrade — payload files are replaced, while the env file and data dir are
# kept so owner tokens, ports, pairing state and the store survive.
#
#   sh install.sh [--prefix PATH] [--bind ADDR] [--port N] [--project DIR]
#
# Requires: node >= 24.18 (device-gateway uses node:sqlite) on PATH,
# systemctl --user (systemd user session). The gateway runs the LOCAL_CLI
# (free LAN) profile: phones pair over LAN/mDNS and launch local CLI agents
# (claude/codex/pi detected on PATH); member/relay features are not part of
# this package.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/agent-link"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-link"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PROJECT_DIR="$HOME/agent-link-projects"
BIND=""
PORT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)  PREFIX=$2;     shift 2 ;;
        --bind)    BIND=$2;       shift 2 ;;
        --port)    PORT=$2;       shift 2 ;;
        --project) PROJECT_DIR=$2; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

die() { echo "agent-link install: $*" >&2; exit 1; }

NODE=$(command -v node) || die "node >= 24.18 is required on PATH"
node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>24||(a===24&&b>=18)?"1":"0")')
[ "$node_ok" = 1 ] || die "node >= 24.18 required (found $(node --version)) — the gateway uses node:sqlite"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
systemctl --user show-environment >/dev/null 2>&1 \
    || die "systemd --user is unavailable (log in a user session; for headless use: loginctl enable-linger $USER)"

upgrade=0
[ -f "$PREFIX/device-gateway.mjs" ] && upgrade=1
if [ "$upgrade" = 1 ]; then
    systemctl --user stop agent-link.service 2>/dev/null || true
    echo "upgrading existing Agent Link in $PREFIX"
fi

mkdir -p "$PREFIX" "$CONFIG_DIR" "$UNIT_DIR" "$PROJECT_DIR"
cp "$HERE/device-gateway.mjs" "$PREFIX/device-gateway.mjs"
[ -f "$HERE/cli-bridge.mjs" ] && cp "$HERE/cli-bridge.mjs" "$PREFIX/cli-bridge.mjs"
if [ -d "$HERE/adapters" ]; then
    mkdir -p "$PREFIX/adapters"
    cp -R "$HERE/adapters/." "$PREFIX/adapters/"
fi
chmod 755 "$PREFIX"
mkdir -p "$PREFIX/hooks" "$PREFIX/data"
for f in agent_pre_tool.py install.py; do
    [ -f "$HERE/hooks/$f" ] && cp "$HERE/hooks/$f" "$PREFIX/hooks/$f" || true
done
[ -f "$HERE/release-manifest.json" ] && cp "$HERE/release-manifest.json" "$PREFIX/release-manifest.json"

ENV_FILE="$CONFIG_DIR/env"
if [ ! -f "$ENV_FILE" ]; then
    # First install: allocate free loopback/LAN ports and generate owner
    # secrets into a 0600 env file. Ports are probed by binding :0 so the
    # kernel hands back a free one.
    PHONE_PORT=${PORT:-$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"0.0.0.0",()=>{console.log(s.address().port);s.close()})')}
    OWNER_PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    HOOKS_PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    PHONE_BIND=${BIND:-0.0.0.0}
    rand() { node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }
    umask 077
    {
        echo "DEVICE_GATEWAY_DATA_DIR=$PREFIX/data"
        echo "DEVICE_GATEWAY_BIND=$PHONE_BIND"
        echo "DEVICE_GATEWAY_PORT=$PHONE_PORT"
        echo "DEVICE_GATEWAY_OWNER_BIND=127.0.0.1"
        echo "DEVICE_GATEWAY_OWNER_PORT=$OWNER_PORT"
        echo "DEVICE_GATEWAY_OWNER_TOKEN=$(rand)"
        echo "DEVICE_GATEWAY_OWNER_CLIENT_TOKEN=$(rand)"
        echo "DEVICE_GATEWAY_HOOKS_PORT=$HOOKS_PORT"
        echo "DEVICE_GATEWAY_HOOKS_TOKEN=$(rand)"
        echo "DEVICE_GATEWAY_DISPLAY_NAME=\"$(hostname -s 2>/dev/null || hostname)\""
        # Free LAN tier: LOCAL_CLI profile + cli-bridge agent supervisor.
        # Member/relay pairing is intentionally not configured here.
        echo "DEVICE_GATEWAY_PROFILE=LOCAL_CLI"
        echo "CLI_BRIDGE_HOST=$PREFIX/cli-bridge.mjs"
        echo "CLI_BRIDGE_PROJECT=$PROJECT_DIR"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "generated $ENV_FILE (owner tokens inside — keep private)"
else
    # Upgrades keep the env file; make sure the LOCAL_CLI profile lines exist
    # for env files generated before the agent bridge shipped.
    grep -q '^DEVICE_GATEWAY_PROFILE=' "$ENV_FILE" \
        || echo "DEVICE_GATEWAY_PROFILE=LOCAL_CLI" >> "$ENV_FILE"
    [ -f "$PREFIX/cli-bridge.mjs" ] && {
        grep -q '^CLI_BRIDGE_HOST=' "$ENV_FILE" \
            || echo "CLI_BRIDGE_HOST=$PREFIX/cli-bridge.mjs" >> "$ENV_FILE"
        grep -q '^CLI_BRIDGE_PROJECT=' "$ENV_FILE" \
            || echo "CLI_BRIDGE_PROJECT=$PROJECT_DIR" >> "$ENV_FILE"
    }
fi

# Substitute literal paths into the quoted systemd unit fields.
unit_path() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/[&|\\]/\\&/g'
}
sed -e "s|@NODE@|$(unit_path "$NODE")|g" \
    -e "s|@PREFIX@|$(unit_path "$PREFIX")|g" \
    -e "s|@CONFIG@|$(unit_path "$CONFIG_DIR")|g" \
    -e "s|@ENV_FILE@|$(printf '%s' "$ENV_FILE" | sed -e 's/%/%%/g' -e 's/[&|\\]/\\&/g')|g" \
    -e "s|@PROJECT@|$(unit_path "$PROJECT_DIR")|g" \
    "$HERE/systemd/agent-link.service" > "$UNIT_DIR/agent-link.service"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_DIR/agent-link.service"
sleep 1
if systemctl --user is-active --quiet agent-link.service; then
    echo "agent-link.service: active"
    PHONE=$(grep '^DEVICE_GATEWAY_BIND=' "$ENV_FILE" | cut -d= -f2):$(grep '^DEVICE_GATEWAY_PORT=' "$ENV_FILE" | cut -d= -f2)
    OWNER=$(grep '^DEVICE_GATEWAY_OWNER_PORT=' "$ENV_FILE" | cut -d= -f2)
    echo "phone listener: $PHONE"
    echo "owner console:  http://127.0.0.1:$OWNER (bearer in $ENV_FILE)"
    echo "hooks installer: $PREFIX/hooks/install.py"
else
    journalctl --user -u agent-link.service -n 20 --no-pager >&2 || true
    die "service failed to start — see journalctl --user -u agent-link.service"
fi
