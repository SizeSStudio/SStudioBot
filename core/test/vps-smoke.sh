#!/bin/bash
# Run test/smoke.ts on the VPS as dev with a throwaway SBOT_HOME (models + key from ~/sbot-probes/.secrets.env).
# From the Mac: rsync core, then  ssh <server> 'bash -s' < core/test/vps-smoke.sh
set -e
export PATH=/opt/node/bin:$PATH
H=~/sbot-dev/home; rm -rf $H; mkdir -p $H/config; chmod 700 $H
install -m 600 ~/sbot-probes/.secrets.env $H/secrets.env
set -a; . ~/sbot-probes/.secrets.env; set +a
sed -e "s|MODEL_CHAT|$SBOT_MODEL_CHAT|; s|MODEL_WORK|${SBOT_MODEL_WORK:-$SBOT_MODEL_CHAT}|; s|MODEL_LIGHT|$SBOT_MODEL_LIGHT|; s|MODEL_EXPERT|$SBOT_MODEL_EXPERT|; s|auth: bearer |auth: ${UPSTREAM_AUTH_STYLE:-bearer} |" ~/sbot-dev/app/seed/config/models.yaml > $H/config/models.yaml
cp ~/sbot-dev/app/seed/config/people.yaml $H/config/
cd ~/sbot-dev/app && env -i PATH=$PATH HOME=$HOME SBOT_HOME=$H SBOT_STREAM_CARDS=0 SBOT_PROXY_PORT=7891 timeout 600 node test/smoke.ts 2>&1 | grep -v '^\s*at ' | tail -60
