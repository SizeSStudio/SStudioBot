#!/bin/bash
# Deploy main to the server now instead of waiting for its timer (it polls every few minutes anyway).
#   bash scripts/deploy.sh               deploy the tip of main
#   bash scripts/deploy.sh --ref <sha>   deploy or roll back to a commit on main
#   bash scripts/deploy.sh --status
# SBOT_HOST (ssh name of the server) comes from the environment or ~/.config/sbot/deploy.env. The ssh user needs
# passwordless sudo for /usr/local/lib/sbot/sbot-deploy.
set -euo pipefail
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/sbot/deploy.env"
[ -n "${SBOT_HOST:-}" ] || { [ -f "$cfg" ] && . "$cfg"; }
: "${SBOT_HOST:?set SBOT_HOST or put SBOT_HOST=<ssh name> in $cfg}"
args=""; if [ $# -gt 0 ]; then args=$(printf ' %q' "$@"); fi
exec ssh "$SBOT_HOST" "sudo -n /usr/local/lib/sbot/sbot-deploy$args"
