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

if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now agent-link.service 2>/dev/null || true
fi
rm -f "$UNIT_DIR/agent-link.service"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload || true
rm -rf "$PREFIX"
if [ "$PURGE" = 1 ]; then
    rm -rf "$CONFIG_DIR"
    echo "removed service, payload, env and data"
else
    echo "removed service and payload (kept $CONFIG_DIR for reinstall)"
fi
