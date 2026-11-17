#!/bin/bash
# Egress rules for sbot-w (DESIGN §7.6). Idempotent. Only matches uid sbot-w; nothing else is touched.
set -euo pipefail
PROXY_PORT=7811          # LLM proxy
EGRESS_PORTS=7820:7829   # egress proxies run by the core; the CLI's own sandbox proxy uses a random loopback port, which this chain blocks
# No direct internet and no DNS for sbot-w (P0 2026-11-17): model calls go to the LLM proxy, WebSearch is a server tool behind
# it, WebFetch (settings.env HTTPS_PROXY + skipWebFetchPreflight) and sandboxed commands go through the core's egress proxy.
# DNS is closed too, since queries to the stub resolver would be an exfil channel. Set SBOT_W_PUBLIC=allow to go back.
PUBLIC=${SBOT_W_PUBLIC:-reject}
v4() {
  iptables -N SBOT_W 2>/dev/null || iptables -F SBOT_W
  if [ "$PUBLIC" = allow ]; then
    iptables -A SBOT_W -d 127.0.0.53 -p udp --dport 53 -j ACCEPT
    iptables -A SBOT_W -d 127.0.0.53 -p tcp --dport 53 -j ACCEPT
  fi
  iptables -A SBOT_W -d 127.0.0.1 -p tcp --dport $PROXY_PORT -j ACCEPT
  iptables -A SBOT_W -d 127.0.0.1 -p tcp --dport $EGRESS_PORTS -j ACCEPT   # core's per-worker egress proxies (sandbox httpProxyPort)
  iptables -A SBOT_W -m addrtype --dst-type LOCAL -j REJECT          # loopback + this machine's own IPs (public IP too)
  for n in 100.64.0.0/10 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
    iptables -A SBOT_W -d $n -j REJECT                                  # tailnet, private, docker bridges, cloud metadata
  done
  if [ "$PUBLIC" = allow ]; then iptables -A SBOT_W -j RETURN; else iptables -A SBOT_W -j REJECT; fi
  iptables -C OUTPUT -m owner --uid-owner sbot-w -j SBOT_W 2>/dev/null || iptables -I OUTPUT 1 -m owner --uid-owner sbot-w -j SBOT_W
}
v6() {
  ip6tables -N SBOT_W 2>/dev/null || ip6tables -F SBOT_W
  ip6tables -A SBOT_W -m addrtype --dst-type LOCAL -j REJECT
  for n in fd7a:115c:a1e0::/48 fc00::/7 fe80::/10; do ip6tables -A SBOT_W -d $n -j REJECT; done
  if [ "$PUBLIC" = allow ]; then ip6tables -A SBOT_W -j RETURN; else ip6tables -A SBOT_W -j REJECT; fi
  ip6tables -C OUTPUT -m owner --uid-owner sbot-w -j SBOT_W 2>/dev/null || ip6tables -I OUTPUT 1 -m owner --uid-owner sbot-w -j SBOT_W
}
v4; v6
