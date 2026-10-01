#!/bin/bash
# Deploys Pitcrew to the host: sync, build the computer and app images, (re)start the control plane.
# Usage: deploy/deploy.sh [--computer]   (--computer also rebuilds the crew computer image)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${PITCREW_SSH:-host}
rsync -a --delete --exclude .git --exclude poc ./ "$HOST:/root/pitcrew-app/"
ssh "$HOST" bash -s -- "${1:-}" <<'REMOTE'
set -euo pipefail
cd /root/pitcrew-app
install -d -m 700 /srv/pitcrew/data
install -d -m 755 /srv/pitcrew/bots /srv/pitcrew/run
install -d -m 711 /srv/pitcrew/brains
install -d -m 770 -o 1500 -g 1500 /srv/pitcrew/chatgpt
# Per-crew-member Codex uids share gid 1500 and read the ChatGPT token through it.
[ -f /srv/pitcrew/chatgpt/auth.json ] && chmod 660 /srv/pitcrew/chatgpt/auth.json
if [ "${1:-}" = "--computer" ] || ! docker image inspect pitcrew-computer:1 >/dev/null 2>&1; then
  docker build -t pitcrew-computer:1 computer
fi
docker build -t pitcrew-brain:1 brain
docker build -t pitcrew-app:1 app
docker compose -f deploy/compose.yml up -d --force-recreate
# The app restarts the brain at boot, so give it a few seconds.
for i in $(seq 1 30); do curl -fs http://172.17.0.1:8330/healthz >/dev/null && break; sleep 1; done
curl -fsS http://172.17.0.1:8330/healthz && echo " app healthy"
docker cp deploy/e2e.mjs pitcrew-app:/app/deploy-e2e.mjs
REMOTE
