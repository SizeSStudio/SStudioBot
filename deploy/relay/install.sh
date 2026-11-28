#!/bin/bash
# Install or update sbot-relay (docs/tech/06 「中继」) from a checkout. Run as root:
#   sudo bash deploy/relay/install.sh [<git ref>]       (default HEAD)
# Puts relay/ + protocol/envelope.ts at that ref into /opt/sbot-relay/releases/<sha> with only the relay's deps
# (npm ci --ignore-scripts from the lockfile), switches /opt/sbot-relay/current, installs the unit and its journal
# namespace, and (re)starts it on 127.0.0.1:7840. It does NOT touch nginx and opens nothing to the internet: the
# public entrance (nginx-relay.conf.example, DNS, certificate) is the owner's decision, made by hand.
# Idempotent. relay.yaml is created empty once and never overwritten.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
ref=${1:-HEAD}
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
base=/opt/sbot-relay
node=/opt/node/bin/node
npm=/opt/node/bin/npm

getent group sbot-relay >/dev/null || groupadd --system sbot-relay
id -u sbot-relay >/dev/null 2>&1 || useradd --system --gid sbot-relay --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sbot-relay

# 1) the release: only what the relay runs, owned by root, readable by the service
install -d -m 0755 "$base" "$base/releases"
rel="$base/releases/$sha"
if [ ! -d "$rel" ]; then
  tmp=$(mktemp -d "$base/releases/.new-XXXXXX")
  # npm ci needs every workspace's package.json to read the lockfile; -w relay installs the relay's deps only
  git -C "$repo" archive "$sha" package.json package-lock.json relay protocol/package.json protocol/envelope.ts hub/package.json node/package.json \
    | tar -x -C "$tmp"
  rm -rf "$tmp/relay/test"
  (cd "$tmp" && PATH=/opt/node/bin:$PATH "$npm" ci --omit=dev --ignore-scripts --no-audit --no-fund --update-notifier=false -w relay --loglevel=error)
  echo "$sha" > "$tmp/REVISION"
  chmod -R a+rX,go-w "$tmp"
  mv "$tmp" "$rel"
fi
ln -sfn "releases/$sha" "$base/.current-new" && mv -Tf "$base/.current-new" "$base/current"

# 2) relay.yaml: hub public keys and sha256 of their tokens; no secret, but nobody else needs to read it
install -d -o root -g sbot-relay -m 0750 /etc/sbot-relay
if [ ! -f /etc/sbot-relay/relay.yaml ]; then
  cat > /etc/sbot-relay/relay.yaml <<'YAML'
# docs/tech/06. One entry per hub allowed to register. After editing: systemctl reload sbot-relay
listen: { host: 127.0.0.1, port: 7840 }
hubs: []
#  - { hub_pk: "<sbot status: relay.yaml 的 hub_pk>", token_hash: "<sha256 hex of RELAY_TOKEN>" }
# limits: { conn_per_min: 20, first_reply_ms: 10000, auth_fail_max: 10, ban_s: 3600 }   # 06's defaults
YAML
  chown root:sbot-relay /etc/sbot-relay/relay.yaml
  chmod 0640 /etc/sbot-relay/relay.yaml
fi

# 3) unit + 14-day journal namespace
install -m 0644 "$here/sbot-relay.service" /etc/systemd/system/sbot-relay.service
install -m 0644 "$here/journald@sbot-relay.conf" /etc/systemd/journald@sbot-relay.conf
systemctl daemon-reload
systemctl enable sbot-relay.service
systemctl restart sbot-relay.service
sleep 1
systemctl --no-pager --lines=0 status sbot-relay.service || true
curl -fsS http://127.0.0.1:7840/healthz || echo "healthz didn't answer; journalctl --namespace=sbot-relay -u sbot-relay" >&2

cat <<'MSG'

sbot-relay is up on 127.0.0.1:7840 only. To use it (owner's steps, by hand):
  1) a registration token, written straight into secrets.env and never shown; prints only its sha256:
       t=$(openssl rand -base64 32 | tr -d '\n='); printf 'RELAY_TOKEN=%s\n' "$t" >> <SBOT_HOME>/secrets.env; printf '%s' "$t" | sha256sum | cut -d' ' -f1; unset t
  2) /etc/sbot-relay/relay.yaml: add { hub_pk: <from sbot status>, token_hash: <that sha256> }; systemctl reload sbot-relay
  3) the public entrance: DNS (no CDN proxy), a certificate, deploy/relay/nginx-relay.conf.example with __HOST__ filled in
  4) console.yaml: relay: { enabled: true, url: wss://<host>/v1/hub } (a widening), then restart the hub
MSG
