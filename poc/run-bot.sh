#!/bin/bash
# Runs a command inside one crew member's own computer: hardened container, own profile volume, own network.
# Usage (on the host): ./run-bot.sh <bot> [cmd...]   e.g. ./run-bot.sh bills node /poc/probe.mjs p5 gpt-6-astra openai
set -euo pipefail
cd "$(dirname "$0")"
BOT=$1; shift
KEY_SRC=${KEY_SRC:?set KEY_SRC to a root-only env file with the provider keys}
PORT=${LIVE_PORT:-6080}
mkdir -p logs work .codex-home && chown -R 1500 logs work .codex-home && chmod 700 .codex-home
cp "${CODEX_CONFIG:-config-cu.toml}" .codex-home/config.toml && chown 1500 .codex-home/config.toml
docker network inspect "pc-net-$BOT" >/dev/null 2>&1 || docker network create "pc-net-$BOT" >/dev/null
exec docker run --rm --name "pc-bot-$BOT" --hostname "$BOT" \
  --cpus "${BOT_CPUS:-1}" --memory "${BOT_MEM:-2g}" --pids-limit 512 --shm-size 512m \
  --read-only --tmpfs /tmp:size=256m,mode=1777 --tmpfs /home/probe:size=64m,uid=1500,gid=1500,mode=700 \
  --cap-drop ALL --security-opt no-new-privileges \
  --network "${BOT_NET:-pc-net-$BOT}" -p "127.0.0.1:$PORT:6080" \
  -v "pc-profile-$BOT:/bot" -v "$PWD:/poc" \
  --env-file <(grep -m1 '^OPENROUTER_API_KEY=' "$KEY_SRC") -e JEV_MODEL="${JEV_MODEL:-}" \
  pitcrew-bot:0.1 "$@"
