#!/bin/bash
# Kill test (run on the VPS as dev): stop sbot-core, inject one owner-DM inbox row (reply goes to the owner DM by
# chat_id), start, wait for "run start", wait $1 s, SIGKILL the service cgroup. systemd restarts it (RestartSec=3).
#   bash vps-killtest.sh <delay_s> "<text>"
set -e
D=${1:-1}; TEXT=${2:-"【kill 测试，Claude 注入】请用两句话介绍你自己。"}
CHAT=$(sudo -n -u sbot /opt/node/bin/node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/srv/sbot/db/sbot.db",{readOnly:true});console.log(d.prepare("SELECT v FROM kv WHERE k=?").get("feishu.owner_dm_chat").v)')
sudo -n systemctl stop sbot-core
ID="killtest-$(date +%s)"
sudo -n -u sbot /opt/node/bin/node -e '
const {DatabaseSync}=require("node:sqlite"); const [id, chat, text]=process.argv.slice(1);
const d=new DatabaseSync("/srv/sbot/db/sbot.db"); const now=Date.now();
const turn=JSON.stringify({channel:"feishu", chat_id:chat, surface:"feishu:dm"});
d.prepare("INSERT INTO inbox(lane,kind,source,source_msg_id,turn_ctx_json,payload_json,status,ts) VALUES(?,?,?,?,?,?,?,?)").run("feishu:dm:owner","user","test",id,turn,JSON.stringify({text,ts:now}),"received",now);
d.prepare("INSERT INTO messages(id,surface,chat_id,sender_id,sender_kind,ts,text,lane) VALUES(?,?,?,?,?,?,?,?)").run(id,"feishu:dm",chat,"owner","owner",now,text,"feishu:dm:owner");
' "$ID" "$CHAT" "$TEXT"
echo "injected $ID"
sudo -n systemctl start sbot-core
if sudo -n timeout 60 journalctl -u sbot-core -f -n 0 -o cat | grep --line-buffered -m1 "run start" | head -c 160; then
  echo; sleep "$D"; sudo -n systemctl kill -s KILL sbot-core && echo "KILLED ${D}s after run start"
else echo "no run started; not killing"; fi
