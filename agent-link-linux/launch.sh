#!/bin/sh
set -eu
prefix=$1
project=$2
slot=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
case "${CLI_BRIDGE_HOST:-}" in
    ""|"$prefix/cli-bridge.mjs")
        export CLI_BRIDGE_HOST="$slot/cli-bridge.mjs"
        ;;
esac
export CLI_BRIDGE_PROJECT="${CLI_BRIDGE_PROJECT:-$project}"
export DEVICE_GATEWAY_PROFILE="${DEVICE_GATEWAY_PROFILE:-LOCAL_CLI}"
export DEVICE_GATEWAY_STARTUP_UPDATE_FILE="$prefix/program/pending"
exec "$slot/runtime/node" "$slot/device-gateway.mjs"
