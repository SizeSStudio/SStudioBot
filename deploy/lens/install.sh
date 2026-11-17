#!/bin/bash
# Install the lens plugin on the VPS (root). Read-only for everyone; sbot-w can read and execute, never write.
#   scp deploy/lens/out/sbot-lens.tgz deploy/lens/install.sh <server>:/tmp/ && ssh <server> sudo bash /tmp/install.sh /tmp/sbot-lens.tgz
set -euo pipefail
tgz=${1:?usage: install.sh sbot-lens.tgz}
root=/opt/sbot/plugins
install -d -m 755 -o root -g root "$root"
tmp=$(mktemp -d "$root/.sbot-lens.XXXX")
tar -C "$tmp" --no-same-owner -xzf "$tgz"
chown -R root:root "$tmp/sbot-lens"; chmod -R u=rwX,go=rX "$tmp/sbot-lens"
rm -rf "$root/sbot-lens.old"; [ -d "$root/sbot-lens" ] && mv "$root/sbot-lens" "$root/sbot-lens.old"
mv "$tmp/sbot-lens" "$root/sbot-lens"; rmdir "$tmp"
echo "installed $(cat "$root/sbot-lens/.claude-plugin/plugin.json")"
