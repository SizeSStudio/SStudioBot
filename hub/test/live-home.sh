#!/bin/bash
# Feishu live test on the server (08 P9 「真测」, 09 「测试应用」), on a FRESH throwaway home every time (never reused or
# deleted). There is no separate test app: this uses the live bot app on purpose, and while it holds a long connection
# Feishu splits the app's events and clicks between it and the live core at random (my decision, accepted).
#   rsync -a --delete --exclude .git --exclude node_modules ./ <server>:sbot-dev/p9live/app/ && ssh <server> 'cd sbot-dev/p9live/app && npm ci --ignore-scripts'
#   ssh <server> 'bash -s -- hub hub/test/live-feishu.ts <phase> [port]' < hub/test/live-home.sh
#   ssh <server> 'bash -s -- p9 <scenario> [run.ts options…]' < hub/test/live-home.sh   # probes/p9 synced to sbot-dev/p9live/p9
#   first time only: LIVE_CREATE_CHAT=1 creates the test chat 「sbot 测试」 (me and the bot)
# Copied from the live instance, server-side by live-creds.ts (sudo; never printed, never on a command line): the app id
# and secret and my open_id. Nothing else; live files are only read. Sends go only to the test chat and my DM.
set -euo pipefail
what=${1:?hub|p9}; shift
SRC=${SBOT_LIVE_SRC:-$HOME/sbot-dev/p9live}
T=/srv/data/sbot/testhomes/live-$what-$(basename "${1:-x}" .ts)-$(date +%m%d%H%M%S)
[ -e "$T" ] && { echo "$T already exists" >&2; exit 1; }
sudo -n mkdir -p "$T/config" "$T/app"
sudo -n rsync -a "$SRC/app/" "$T/app/"
sudo -n /opt/node/bin/node "$T/app/hub/test/live-creds.ts" "$T" ${LIVE_CREATE_CHAT:+--create-chat}
[ "$what" = p9 ] && sudo -n rsync -a "$SRC/p9/" "$T/p9/"
sudo -n chown -R sbot:sbot "$T"
echo "home: $T"
run() { sudo -n -u sbot env -i PATH=/opt/node/bin:/opt/sbot/bin:/usr/bin:/bin HOME="$T" LANG=C.UTF-8 "$@"; }
case "$what" in
  hub)
    t=${1:?script}; phase=${2:-auto}; port=${3:-7830}
    case "$port" in 7829|7830|7831) ;; *) echo "port must be 7829-7831" >&2; exit 2 ;; esac
    run SBOT_HOME="$T" SBOT_SECRETS="$T/secrets.env" SBOT_PORT="$port" SBOT_LOG=off sh -c "cd '$T/app' && exec node '$t' '$phase'" 2>&1 ;;
  p9)
    run P9_CREDENTIALS="$T/p9-creds.json" P9_SHARED_LIVE_APP=1 P9_STATE="$T/p9-state" P9_LARK_CLI=/opt/sbot/bin/lark-cli \
      sh -c "cd '$T/p9' && exec node run.ts $*" ;;
  *) echo "hub|p9" >&2; exit 64 ;;
esac
