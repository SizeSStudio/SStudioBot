#!/bin/bash
# 从本机跑 P10。服务器名读 ~/.config/sbot/deploy.env 的 SBOT_HOST。
#   bash probes/p10/run.sh "" list                 列端点上的模型
#   bash probes/p10/run.sh <跨家模型名> smoke       小跑
#   bash probes/p10/run.sh <跨家模型名> [每格次数]   默认 10
#   bash probes/p10/run.sh "" replay <测试 home>   对照重放
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
. ~/.config/sbot/deploy.env
ssh "$SBOT_HOST" 'mkdir -p ~/sbot-dev/p10/core ~/sbot-dev/p10/probes/p10'   # 自己的中转目录，不碰 ~/sbot-dev/app
rsync -a --delete "$root/core/src" "$root/core/package.json" "$SBOT_HOST:sbot-dev/p10/core/"
rsync -a --delete "$root/probes/p10/" "$SBOT_HOST:sbot-dev/p10/probes/p10/"
printf -v args '%q ' "${1:-}" "${2:-10}" "${3:-}"
ssh "$SBOT_HOST" "bash -s -- $args" < "$root/probes/p10/remote.sh"
