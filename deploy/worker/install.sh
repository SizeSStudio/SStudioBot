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
