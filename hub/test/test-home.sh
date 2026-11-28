#!/bin/bash
# Run a hub smoke test on the server on a FRESH throwaway home (never reuses or deletes one), as the sbot user:
#   rsync -a --delete --exclude .git ./ <server>:sbot-dev/app/      # from a checkout that ran `npm ci --ignore-scripts`
#   ssh <server> 'bash -s' < hub/test/test-home.sh [hub/test/smoke.ts] [port 7829-7831]
# Homes live under /srv/data/sbot/testhomes/<test>-<stamp>; clean them up by hand now and then.
#
# Unlike core/test/vps-test-home.sh this copies nothing from the live instance: no config, no secrets.env. The home
# gets fictional values only, Feishu in shadow mode, and its own throwaway age keypair (made by the smoke script).
set -euo pipefail
t=${1:-hub/test/smoke.ts}; port=${2:-7829}
case "$port" in 7829|7830|7831) ;; *) echo "port must be 7829-7831" >&2; exit 2 ;; esac
T=/srv/data/sbot/testhomes/hub-$(basename "$t" .ts)-$(date +%m%d%H%M%S)
[ -e "$T" ] && { echo "$T already exists" >&2; exit 1; }
sudo -n mkdir -p "$T/config" "$T/app"
sudo -n rsync -a ~/sbot-dev/app/ "$T/app/"
# the only config the home starts with: Feishu never sends from a test home
printf 'feishu:\n  mode: shadow\n' | sudo -n tee "$T/config/channels.yaml" >/dev/null
printf 'SMOKE_FAKE=not-a-secret\n' | sudo -n tee "$T/secrets.env" >/dev/null
sudo -n chmod 600 "$T/secrets.env"
sudo -n chown -R sbot:sbot "$T"
echo "home: $T"
sudo -n -u sbot env -i PATH=/opt/node/bin:/usr/bin:/bin HOME="$T" SBOT_HOME="$T" SBOT_SECRETS="$T/secrets.env" \
  SBOT_PORT="$port" SBOT_LOG=off sh -c "cd '$T/app' && node '$t'" 2>&1
