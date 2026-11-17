#!/bin/bash
# Install (or reinstall) the launchd agent that runs pull.sh at 09:30 and 21:30, and when the Mac logs in.
# A run missed while the Mac slept happens on wake. Remove: launchctl bootout gui/$(id -u)/$LABEL; rm the plist.
set -euo pipefail
LABEL=sbot.backup-pull
: "${SBOT_HOST:?usage: SBOT_HOST=<ssh name of the server> bash install.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/pull.sh</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>EnvironmentVariables</key><dict><key>SBOT_HOST</key><string>$SBOT_HOST</string></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$HOME/Backups/sbot/launchd.err</string>
</dict></plist>
P
mkdir -p "$HOME/Backups/sbot"; chmod 700 "$HOME/Backups/sbot"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL → $PLIST"
