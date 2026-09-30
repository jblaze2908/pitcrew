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
install -d -m 755 /srv/pitcrew/bots /srv/pitcrew/chatgpt
chown 1500:1500 /srv/pitcrew/chatgpt && chmod 700 /srv/pitcrew/chatgpt
if [ "${1:-}" = "--computer" ] || ! docker image inspect pitcrew-computer:1 >/dev/null 2>&1; then
  docker build -t pitcrew-computer:1 computer
fi
docker build -t pitcrew-app:1 app
docker compose -f deploy/compose.yml up -d --force-recreate
sleep 3
curl -fsS http://172.17.0.1:8330/healthz && echo " app healthy"
REMOTE
