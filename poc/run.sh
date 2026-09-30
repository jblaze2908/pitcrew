#!/bin/bash
# Runs one probe in a throwaway, resource-capped container.
# Keys are piped via process substitution from root-only files: never copied, never printed.
# Usage (on the host): ./run.sh p1|p2|p3|p4|jev-eval [model] [openrouter|openai]
set -euo pipefail
cd "$(dirname "$0")"
KEY_SRC=/var/lib/docker/volumes/nullframe_hermes-data/_data/.env
TS_SRC=/root/pitcrew-poc-secrets/typesafe.env
mkdir -p logs work .codex-home && chmod 700 .codex-home && chown -R 1500 logs work .codex-home
cp config.toml .codex-home/config.toml && chown 1500 .codex-home/config.toml
TS_ARGS=(); [ -f "$TS_SRC" ] && TS_ARGS=(--env-file <(grep -m1 '^TYPESAFE_API_KEY=' "$TS_SRC"))
ENTRY=(node /poc/probe.mjs "$@"); [ "$1" = jev-eval ] && ENTRY=(node /poc/jev-eval.mjs)
exec docker run --rm --name "pitcrew-probe-$1" --cpus 1 --memory 2g --shm-size 512m \
  --env-file <(grep -m1 '^OPENROUTER_API_KEY=' "$KEY_SRC") --env-file <(grep -m1 '^AI_GATEWAY_API_KEY=' "$KEY_SRC") "${TS_ARGS[@]}" -e JEV_BACKEND="${JEV_BACKEND:-}" -e JEV_MODEL="${JEV_MODEL:-}" \
  -v "$PWD:/poc" pitcrew-poc:0.1 "${ENTRY[@]}"
