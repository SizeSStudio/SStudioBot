#!/bin/bash
# 在服务器上执行（run.sh 调）：新开一个测试 home，起代理，跑探针。照 core/test/vps-test-home.sh，不碰线上。
set -euo pipefail
cross=${1:-}; mode=${2:-10}; src=${3:-}
T=/srv/data/sbot/testhomes/p10-$(date +%m%d%H%M%S)
sudo -n mkdir -p "$T/config" "$T/app" "$T/logs" "$T/db"
sudo -n cp /srv/sbot/config/models.yaml /srv/sbot/config/people.yaml "$T/config/"
sudo -n rsync -a ~/sbot-dev/p10/ "$T/app/"
sudo -n ln -s /srv/data/sbot-app/current/core/node_modules "$T/app/node_modules"
sudo -n chown -R sbot:sbot "$T"
echo "home: $T"
port=
for p in 7829 7830 7831; do ss -ltnH "sport = :$p" | grep -q . || { port=$p; break; }; done
[ -n "$port" ] || { echo "7829-7831 都被占着" >&2; exit 1; }
echo "proxy port: $port"
as() { sudo -n -u sbot env -i PATH=/opt/node/bin:/opt/sbot/bin:/usr/bin:/bin HOME="$T" SBOT_HOME="$T" "$@" </dev/null; }
[ -z "$cross" ] || as node "$T/app/probes/p10/setup.ts" "$cross"
# 只有代理进程拿得到 SBOT_SECRETS
as SBOT_SECRETS=/srv/sbot/secrets.env SBOT_PROXY_PORT="$port" sh -c "exec node '$T/app/probes/p10/proxy-main.ts' > '$T/logs/proxy.log' 2>&1" &
bg=$!
trap 'pid=$(sudo -n cat "$T/run/proxy.pid" 2>/dev/null) && sudo -n kill "$pid" 2>/dev/null || true; wait $bg 2>/dev/null || true' EXIT
for _ in $(seq 50); do sudo -n test -f "$T/run/tokens.json" && break; sleep 0.2; done
sudo -n test -f "$T/run/tokens.json" || { echo "代理没起来，看 $T/logs/proxy.log" >&2; exit 1; }
if [ "$mode" = replay ]; then cmd=("$T/app/probes/p10/replay.ts" "$src/p10-requests.jsonl"); else cmd=("$T/app/probes/p10/probe.ts" "$mode"); fi
as P10_PROXY="http://127.0.0.1:$port/llm" node "${cmd[@]}"
