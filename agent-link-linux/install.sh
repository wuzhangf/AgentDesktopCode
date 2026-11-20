#!/bin/sh
# User-level Agent Link installation and upgrade. See README.md for options.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RUNTIME="$HERE/runtime/node"

die() { echo "agent-link install: $*" >&2; exit 1; }

[ "$(uname -sm)" = 'Linux x86_64' ] || die "this package requires Linux x86_64"
[ -x "$RUNTIME" ] || die "bundled Node runtime is missing; unpack the full archive"
"$RUNTIME" -e 'const [a,b]=process.versions.node.split(".").map(Number);
require("node:sqlite"); if (a<24 || (a===24 && b<18)) process.exit(1)' \
    || die "bundled Node could not start; check the system libraries and execution permissions"
[ "${1:-}" != diagnostics ] || exec "$RUNTIME" "$HERE/install.mjs" "$@"
command -v flock >/dev/null 2>&1 || die "flock is required"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
systemctl --user show-environment >/dev/null 2>&1 \
    || die "systemd --user is unavailable (log in a user session; for headless use: loginctl enable-linger $USER)"

# Member authorization uses the running gateway and may wait for the account owner.
if [ "${1:-}" = member ]; then
    exec "$RUNTIME" "$HERE/install.mjs" "$@"
fi
mkdir -p "$UNIT_DIR"
exec flock -F -n -E 73 "$UNIT_DIR/.agent-link.install.lock" "$RUNTIME" "$HERE/install.mjs" "$@"
