#!/bin/sh
set -eu

router_key="$(cat /run/secrets/ninerouter-api-key)"
export NINEROUTER_API_KEY="$router_key"
unset router_key

exec codexapp "$@"
