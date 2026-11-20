#!/bin/sh
# Remove the Agent Link device gateway user service and payload.
#
#   sh uninstall.sh [--prefix PATH] [--purge]
#
# Default removal keeps the env file and data dir so a reinstall resumes the
# same identity; --purge deletes them too.
set -eu

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/agent-link"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-link"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PURGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) PREFIX=$2; shift 2 ;;
        --purge)  PURGE=1;   shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

PREFIX=$(realpath -m -- "$PREFIX")
UNIT_DIR=$(realpath -m -- "$UNIT_DIR")
if [ -d "$UNIT_DIR" ]; then
    exec 9>"$UNIT_DIR/.agent-link.install.lock"
    flock -n 9 || { echo 'agent-link uninstall: installation in progress' >&2; exit 1; }
fi
if [ -L "$PREFIX/program" ]; then
    echo 'agent-link uninstall: program directory is not local to the prefix' >&2
    exit 1
fi
if [ -f "$PREFIX/program/pending" ] || [ -f "$PREFIX/program/transaction.json" ]; then
    echo 'agent-link uninstall: an interrupted installation requires recovery' >&2
    exit 1
fi
if [ -f "$UNIT_DIR/agent-link.service" ] && ! grep -Fq -- "$PREFIX/" "$UNIT_DIR/agent-link.service"; then
    echo 'agent-link uninstall: the user service belongs to a different prefix' >&2
    exit 1
fi
if command -v systemctl >/dev/null 2>&1; then
    loaded=$(systemctl --user show agent-link.service --property=FragmentPath --value 2>/dev/null || true)
    if [ -n "$loaded" ] && [ "$(realpath -m -- "$loaded")" != "$UNIT_DIR/agent-link.service" ]; then
        echo 'agent-link uninstall: the user service belongs to a different installation' >&2
        exit 1
    fi
    if [ -d "$PREFIX/program/updater" ]; then
        systemctl --user disable --now agent-link-update.timer 2>/dev/null || true
        systemctl --user disable --now agent-link-update.service 2>/dev/null || true
        systemctl --user disable --now agent-link-update-scheduled.service 2>/dev/null || true
        rm -f "$UNIT_DIR/agent-link-update.timer" "$UNIT_DIR/agent-link-update.service" \
            "$UNIT_DIR/agent-link-update-scheduled.service"
    fi
    systemctl --user disable --now agent-link.service 2>/dev/null || true
fi
rm -f "$UNIT_DIR/agent-link.service"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload || true
if [ -d "$PREFIX/program/versions" ]; then
    rm -f "$PREFIX/program/current" "$PREFIX/program/previous"
    rm -f "$PREFIX/program/last-failed-build"
    rm -rf "$PREFIX/program/versions"
    rm -rf "$PREFIX/program/updater"
    rmdir "$PREFIX/program" 2>/dev/null || true
fi
rm -f "$PREFIX/device-gateway.mjs" "$PREFIX/cli-bridge.mjs" "$PREFIX/release-manifest.json"
rm -f "$PREFIX/runtime/node" "$PREFIX/runtime/node-LICENSE"
rmdir "$PREFIX/runtime" 2>/dev/null || true
rm -f "$PREFIX/hooks/agent_pre_tool.py" "$PREFIX/hooks/install.py"
rm -rf "$PREFIX/adapters"
rmdir "$PREFIX/hooks" 2>/dev/null || true
if [ "$PURGE" = 1 ]; then
    rm -rf "$PREFIX/data" "$PREFIX/updates" "$CONFIG_DIR"
    rmdir "$PREFIX" 2>/dev/null || true
    echo "removed service, payload, env and data"
else
    echo "removed service and payload (kept $CONFIG_DIR and $PREFIX/data for reinstall)"
fi
