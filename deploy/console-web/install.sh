#!/bin/bash
# Turn on the console's public entrance (DESIGN §10.1). Run as root from a checkout, after the core that has
# console-web.ts is deployed and the DNS record (A → this server, DNS only / grey cloud) exists:
#   sudo bash deploy/console-web/install.sh <host>        e.g. console.example.com
# Idempotent. Doesn't set the password or console.yaml web.origin; see the end of its output. The tailnet entrance
# (tailscale serve 8444) is untouched.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
host=${1:?usage: install.sh <host>}
[[ $host =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "bad host: $host" >&2; exit 2; }
site=/etc/nginx/sites-available/sbot-console

getent group sbot-web >/dev/null || groupadd --system sbot-web
usermod -aG sbot-web www-data
install -m 0644 sbot-console-web.tmpfiles /etc/tmpfiles.d/sbot-console-web.conf
systemd-tmpfiles --create /etc/tmpfiles.d/sbot-console-web.conf
install -d -m 0755 /etc/systemd/system/sbot-core.service.d
install -m 0644 sbot-core-console-web.conf /etc/systemd/system/sbot-core.service.d/console-web.conf
systemctl daemon-reload

# 1) port 80 only, so certbot's webroot challenge can pass; 2) the certificate; 3) the full site
if [ ! -f "/etc/letsencrypt/live/$host/fullchain.pem" ]; then
  sed -n '/^server {/,/^}/p' nginx-site.conf | sed -n '1,/^}/p' | sed "s/__HOST__/$host/g" > "$site"
  ln -sf "$site" /etc/nginx/sites-enabled/sbot-console
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/lib/letsencrypt -d "$host" --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
fi
sed "s/__HOST__/$host/g" nginx-site.conf > "$site"
ln -sf "$site" /etc/nginx/sites-enabled/sbot-console
nginx -t
# www-data's new group only reaches workers started after this; a reload starts new workers
systemctl reload nginx
# the core opens the public socket only if /run/sbot-web exists when it starts
systemctl restart sbot-core.service
sleep 3
ls -l /run/sbot-web/

cat <<MSG

Done. Two things left, both as the owner:
  1) password:  sudo -u sbot env SBOT_HOME=/srv/sbot /opt/node/bin/node /srv/data/sbot-app/current/core/src/console-passwd.ts
  2) console.yaml (console → 配置, or edit /srv/sbot/config/console.yaml):   web: { origin: https://$host }
Until both are set, https://$host answers 404.
MSG
