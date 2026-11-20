#!/bin/sh
set -eu
prefix=$1
project=$2
slot=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
withdrawals="$prefix/updates/withdrawn-builds.json"
if [ -e "$withdrawals" ] || [ -L "$withdrawals" ]; then
    "$slot/runtime/node" --input-type=module - "$slot" "$prefix/updates" <<'NODE'
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [slot, updateRoot] = process.argv.slice(2);
try {
  const { isWithdrawn } = await import(pathToFileURL(join(slot, 'slots.mjs')));
  if (isWithdrawn(updateRoot, 'versions/' + basename(slot))) {
    console.error('Agent Link release withdrawn. Start agent-link-update.service for signed repair.');
    process.exitCode = 78;
  }
} catch {
  console.error('Agent Link withdrawal state is invalid. Signed repair is required.');
  process.exitCode = 78;
}
NODE
fi
case "${CLI_BRIDGE_HOST:-}" in
    ""|"$prefix/cli-bridge.mjs")
        export CLI_BRIDGE_HOST="$slot/cli-bridge.mjs"
        ;;
esac
export CLI_BRIDGE_PROJECT="${CLI_BRIDGE_PROJECT:-$project}"
export DEVICE_GATEWAY_PROFILE="${DEVICE_GATEWAY_PROFILE:-LOCAL_CLI}"
export DEVICE_GATEWAY_STARTUP_UPDATE_FILE="$prefix/program/pending"
exec "$slot/runtime/node" "$slot/device-gateway.mjs"
