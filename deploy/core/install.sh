#!/bin/bash
# Install or update the core's root-level pieces (DESIGN §底1.3): systemd units and the deploy tool. Run as root from a
# checkout; re-run after changing anything in deploy/core/. Then it deploys main and turns on auto-deploy.
#   sudo bash deploy/core/install.sh            (SBOT_NO_AUTODEPLOY=1 to leave sbot-deploy.timer off)
# Assumes the users, /srv/sbot (→ /srv/data/sbot) with config/ and secrets.env, /opt/node, and lark-cli are in place.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
install -d -m 0755 /usr/local/lib/sbot /etc/sbot
install -m 0755 -o root -g root sbot-deploy /usr/local/lib/sbot/sbot-deploy
install -d -o root -g sbot -m 0750 /srv/data/sbot-app
for u in sbot-core.service sbot-backup.service sbot-backup.timer sbot-deploy.service sbot-deploy.timer; do
  install -m 0644 "$u" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable sbot-core.service
systemctl enable --now sbot-backup.timer
/usr/local/lib/sbot/sbot-deploy          # builds the release, switches, (re)starts sbot-core and checks it came up
if [ "${SBOT_NO_AUTODEPLOY:-}" != 1 ]; then systemctl enable --now sbot-deploy.timer; fi
/usr/local/lib/sbot/sbot-deploy --status
