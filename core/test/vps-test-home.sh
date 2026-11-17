#!/bin/bash
# Run one smoke test on the VPS on a FRESH throwaway home (never reuses or deletes one), as sbot:
#   ssh <server> 'bash -s' < test/vps-test-home.sh <test.ts> [port] [args…]   # after rsync to ~/sbot-dev/app
# Homes live under /srv/data/sbot/testhomes/<test>-<stamp>; clean them up by hand now and then.
set -euo pipefail
t=${1:?test file}; port=${2:-7899}; shift $(( $# >= 2 ? 2 : 1 ))
T=/srv/data/sbot/testhomes/$(basename "$t" .ts)-$(date +%m%d%H%M%S)
sudo -n mkdir -p "$T/config" "$T/app"
sudo -n cp /srv/sbot/config/models.yaml /srv/sbot/config/people.yaml "$T/config/"
sudo -n rsync -a --exclude node_modules ~/sbot-dev/app/ "$T/app/"
sudo -n ln -s /srv/data/sbot-app/current/core/node_modules "$T/app/node_modules"
sudo -n chown -R sbot:sbot "$T"
echo "home: $T"
sudo -n -u sbot env PATH=/opt/node/bin:/opt/sbot/bin:/usr/bin:/bin SBOT_HOME="$T" SBOT_SECRETS=/srv/sbot/secrets.env \
  SBOT_PROXY_PORT="$port" SBOT_LARK_CLI=/bin/false sh -c "cd '$T/app' && node test/$(basename "$t") $*" 2>&1 \
  | grep -v '^{' | grep -v '\[memory\] seeded'
