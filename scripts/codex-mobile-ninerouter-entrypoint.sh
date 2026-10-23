#!/bin/sh
set -eu

router_key="$(cat /run/secrets/ninerouter-api-key)"
export NINEROUTER_API_KEY="$router_key"
unset router_key

case "$NINEROUTER_API_KEY" in
  *[![:space:]]*) ;;
  *) printf '%s\n' 'NineRouter API key secret is empty' >&2; exit 1 ;;
esac

exec codexapp "$@"
