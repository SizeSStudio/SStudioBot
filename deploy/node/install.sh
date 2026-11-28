#!/bin/bash
# Install sbot-node (docs/tech/05 「安装和配对」). Run by hand; nothing runs it automatically.
#   Mac (my own account):        bash deploy/node/install.sh
#   the hub's server, as root:   SBOT_NODE_SOCK=<hub's hub.sock> bash deploy/node/install.sh --server
# Layout (the same one the self-upgrade uses, node/src/upgrade.ts): <root>/repo (a clone), <root>/releases/<sha>,
# <root>/current -> releases/<sha>. The first release is origin/main's head, set up the way an upgrade is: git archive,
# npm ci --ignore-scripts, the self-check. Pairing is separate: a Mac runs `sbot-node pair '<link>'` afterwards; the
# server's node uses hub.sock and is not paired.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
src=$(cd "$here/../.." && pwd -P)
mode=user
[ "${1:-}" = --server ] && mode=server
# where to clone from: this checkout's origin (no URL kept in the repo)
url=${SBOT_NODE_REPO:-$(git -C "$src" remote get-url origin)}

if [ "$mode" = server ]; then
  [ "$(id -u)" = 0 ] || { echo "install.sh --server: run as root" >&2; exit 64; }
  [ -n "${SBOT_NODE_SOCK:-}" ] || { echo "install.sh --server: set SBOT_NODE_SOCK to the hub's hub.sock" >&2; exit 64; }
  id sbot-h >/dev/null 2>&1 || { echo "install.sh --server: no sbot-h account (deploy/worker/install.sh makes it)" >&2; exit 64; }
  root=/srv/data/sbot-h/node
  node=/opt/node/bin/node
  as() { sudo -u sbot-h -H -- "$@"; }
  install -d -o sbot-h -g sbot-h -m 0750 "$root"
else
  [ "$(uname -s)" = Darwin ] || { echo "install.sh: without --server this is for a Mac (launchd)" >&2; exit 64; }
  root=${SBOT_NODE_ROOT:-$HOME/.local/share/sbot-node}
  node=$(command -v node) || { echo "install.sh: node (>= 24) not on PATH" >&2; exit 64; }
  as() { "$@"; }
  install -d -m 0700 "$root"
fi
"$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || { echo "install.sh: node >= 24 needed" >&2; exit 64; }

# the clone the upgrades fetch into
if [ -d "$root/repo/.git" ]; then as git -C "$root/repo" fetch -q origin
else as git clone -q "$url" "$root/repo"; fi
sha=$(as git -C "$root/repo" rev-parse origin/main)
rel=$root/releases/$sha
if [ ! -f "$rel/.ok" ]; then
  tmp=$root/releases/.tmp-$sha
  as rm -rf "$tmp"
  as mkdir -p "$tmp"
  as git -C "$root/repo" -c core.hooksPath=/dev/null archive -o "$tmp.tar" "$sha"
  as tar -xf "$tmp.tar" -C "$tmp"
  as rm -f "$tmp.tar"
  echo "$sha" | as tee "$tmp/REVISION" >/dev/null
  (cd "$tmp" && as npm ci --ignore-scripts --omit=dev --no-audit --no-fund -w node -w protocol)
  out=$(cd "$tmp" && as "$node" node/src/cli.ts selftest)
  [ "$out" = "selftest ok" ] || { echo "install.sh: self-check failed: $out" >&2; exit 1; }
  as mv "$tmp" "$rel"
  as touch "$rel/.ok"
fi
as ln -sfn "$rel" "$root/current.new"
as mv -f "$root/current.new" "$root/current"   # mv -f over a symlink: an atomic swap on both systems
echo "sbot-node release $sha in $root/current"

if [ "$mode" = server ]; then
  umask 022
  printf 'SBOT_NODE_SOCK=%s\n' "$SBOT_NODE_SOCK" > /etc/sbot-node.env
  install -m 0644 "$here/sbot-node.service" /etc/systemd/system/sbot-node.service
  systemctl daemon-reload
  systemctl enable --now sbot-node.service
  systemctl is-active sbot-node.service
  echo "the hub's node dir must be group sbot-h (SBOT_NODE_GROUP=sbot-h for the hub), or the node can't reach hub.sock"
else
  plist=$HOME/Library/LaunchAgents/local.sbot-node.plist
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  esc() { printf '%s' "$1" | sed -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[&#\\]/\\&/g'; }
  sed -e "s#@NODE@#$(esc "$node")#g" -e "s#@ROOT@#$(esc "$root")#g" -e "s#@PATH@#$(esc "$PATH")#g" -e "s#@HOME@#$(esc "$HOME")#g" \
    "$here/sbot-node.plist.in" > "$plist.new"
  plutil -lint "$plist.new" >/dev/null
  mv -f "$plist.new" "$plist"
  launchctl bootout "gui/$(id -u)/local.sbot-node" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "launchd: local.sbot-node loaded; logs in ~/Library/Logs/sbot-node.log"
  if ! "$node" "$root/current/node/src/cli.ts" status >/dev/null 2>&1; then
    echo "not paired yet: $node $root/current/node/src/cli.ts pair '<link>'   (the link from 「加一台」, kind node)"
  fi
fi
