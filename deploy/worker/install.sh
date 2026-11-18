#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
command -v socat >/dev/null || apt-get install -y -qq socat >/dev/null
install -d -m 0755 /usr/local/lib/sbot /opt/sbot/claude-code/2.1.325
install -d -o sbot-w -g sbot-w -m 0750 /srv/data/sbot-w/home
install -m 0755 -o root -g root worker-exec task-mkdir netfilter.sh /usr/local/lib/sbot/
install -d -m 0755 /usr/local/lib/sbot/bin && install -m 0755 -o root -g root bwrap /usr/local/lib/sbot/bin/bwrap
# Ubuntu 24.04+: bwrap-userns-restrict denies the nested userns Claude Code's apply-seccomp needs; use the profile from code.claude.com/docs/en/sandboxing
if [ -f /etc/apparmor.d/bwrap-userns-restrict ] && [ ! -e /etc/apparmor.d/disable/bwrap-userns-restrict ]; then
  mkdir -p /etc/apparmor.d/disable; ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/; apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict || true
fi
install -m 0644 apparmor-bwrap /etc/apparmor.d/bwrap && apparmor_parser -r /etc/apparmor.d/bwrap
CLAUDE_BIN="${CLAUDE_BIN:-/srv/data/sbot-app/current/core/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude}"   # the SDK's bundled Claude Code
install -m 0755 -o root -g root "$CLAUDE_BIN" /opt/sbot/claude-code/2.1.325/claude
ln -sfn /opt/sbot/claude-code/2.1.325 /opt/sbot/claude-code/current
install -m 0440 -o root -g root sudoers-sbot /etc/sudoers.d/sbot
visudo -cf /etc/sudoers.d/sbot
install -m 0644 sbot-netfilter.service /etc/systemd/system/
systemctl daemon-reload; systemctl enable --now sbot-netfilter.service
systemctl is-active sbot-netfilter.service
iptables -S SBOT_W; iptables -S OUTPUT | head -2; ip6tables -S SBOT_W | head -3
sudo -u sbot-w /opt/sbot/claude-code/current/claude --version

# ---- host-mode worker sbot-h (DESIGN §4.2, §7.6): runs on the host, full network/tailnet, full sudo, persistent HOME
H=/srv/data/sbot-h
getent group sbot-h >/dev/null || groupadd --system sbot-h
id sbot-h >/dev/null 2>&1 || useradd --system --gid sbot-h --home-dir $H/home --shell /bin/bash sbot-h
usermod -aG sbot-h sbot                  # the core reads host task dirs (repo fetch), like group sbot-w
install -d -o root -g root -m 0755 $H
install -d -o sbot-h -g sbot-h -m 0750 $H/home $H/tasks
install -d -o sbot-h -g sbot-h -m 0700 $H/home/.ssh
install -d -o sbot-h -g sbot-h -m 0755 $H/home/.local $H/home/.local/bin
[ -f $H/home/.ssh/id_ed25519 ] || sudo -u sbot-h ssh-keygen -q -t ed25519 -N "" -C "sbot-h@$(hostname -s)" -f $H/home/.ssh/id_ed25519
# ssh hosts come from config/worker.yaml; the core writes them to the shared dir, the user's own config includes it
grep -qs "^Include /srv/data/sbot-shared/ssh_config" $H/home/.ssh/config || {
  { echo "Include /srv/data/sbot-shared/ssh_config"; cat $H/home/.ssh/config 2>/dev/null || true; } > $H/home/.ssh/config.new
  install -m 0600 -o sbot-h -g sbot-h $H/home/.ssh/config.new $H/home/.ssh/config; rm -f $H/home/.ssh/config.new
}
# shared, world-readable, written by the core: skills plugin + ssh_config (no secrets in here)
install -d -o sbot -g sbot -m 0755 /srv/data/sbot-shared
install -m 0440 -o root -g root sudoers-sbot-h /etc/sudoers.d/sbot-h
visudo -cf /etc/sudoers.d/sbot-h
sudo -u sbot-h sudo -n true && echo "sbot-h sudo ok"
echo "sbot-h public key (add it to ~/.ssh/authorized_keys on the machines listed in config/worker.yaml ssh_hosts):"
cat $H/home/.ssh/id_ed25519.pub
echo "core unit: install deploy/core/sbot-core.service again (ReadWritePaths gained sbot-h and sbot-shared) and restart sbot-core"
