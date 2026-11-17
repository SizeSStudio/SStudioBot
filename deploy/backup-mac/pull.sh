#!/bin/bash
# Off-site copy of SStudioBot's nightly backup onto the owner's Mac (DESIGN §1.3).
#
#   bash pull.sh            (launchd runs it: install.sh)
#
# The server keeps the last 7 days in /srv/sbot/backup-out/<day>/ (sbot.db.gz, config.bundle, agent-home.bundle,
# manifest.json). Each day we don't have yet is copied here, checked (sha256 against the manifest, SQLite
# integrity_check, git bundles readable) and only then moved into place. Then it writes the newest day it holds to
# backup-out/pulled on the server, so Sentinel can tell when this Mac has stopped pulling. Keeps everything (~15 KB a day).
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
HOST="${SBOT_HOST:?set SBOT_HOST to the ssh name of the server (install.sh writes it into the launchd job)}"
REMOTE=/srv/sbot/backup-out
DEST="${SBOT_BACKUP_DIR:-$HOME/Backups/sbot}"
mkdir -p "$DEST"; chmod 700 "$DEST"
exec >>"$DEST/pull.log" 2>&1
say() { echo "$(date '+%F %T') $*"; }
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

days=$("${SSH[@]}" "sudo -n ls $REMOTE" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || true)
[ -n "$days" ] || { say "nothing on the server yet"; exit 0; }
got=0
for day in $days; do
  [ -d "$DEST/$day" ] && continue
  tmp=$(mktemp -d "$DEST/.pull.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  "${SSH[@]}" "sudo -n tar -C $REMOTE -cf - $day" | tar -xf - -C "$tmp"
  d="$tmp/$day"
  [ -f "$d/manifest.json" ] || { say "$day: no manifest, skipped"; rm -rf "$tmp"; continue; }
  # every file the manifest lists, with the right hash
  bad=$(cd "$d" && python3 -I -c '
import json, hashlib
m = json.load(open("manifest.json"))
for n, f in m["files"].items():
    try: ok = hashlib.sha256(open(n, "rb").read()).hexdigest() == f["sha256"]
    except OSError: ok = False
    if not ok: print(n)
')
  [ -z "$bad" ] || { say "$day: hash mismatch: $bad"; exit 1; }
  if [ -f "$d/sbot.db.gz" ]; then
    gunzip -c "$d/sbot.db.gz" > "$tmp/check.db"
    ic=$(sqlite3 "$tmp/check.db" "PRAGMA integrity_check;")
    [ "$ic" = "ok" ] || { say "$day: sqlite integrity_check: $ic"; exit 1; }
    rm -f "$tmp/check.db"
  fi
  for b in "$d"/*.bundle; do [ -e "$b" ] || continue; git bundle list-heads "$b" >/dev/null || { say "$day: unreadable $(basename "$b")"; exit 1; }; done
  mv "$d" "$DEST/$day"; chmod -R go-rwx "$DEST/$day"
  rm -rf "$tmp"; trap - EXIT
  say "$day: ok ($(du -sk "$DEST/$day" | cut -f1) KB)"; got=$((got + 1))
done
newest=$(ls "$DEST" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort | tail -1)
echo "$newest" | "${SSH[@]}" "sudo -n -u sbot tee $REMOTE/pulled >/dev/null"
[ "$got" -gt 0 ] || say "up to date ($newest)"
