#!/bin/sh
# A crew member's computer, stage 1: only Codex's exec-server, so the brain's shell and apply_patch run here.
# The desktop (stage 2) boots later via `pitcrew-desktop`, on the first browser or pixel tool.
set -eu
export HOME=/home/crew XDG_CONFIG_HOME=/bot/config XDG_CACHE_HOME=/tmp/cache CODEX_HOME=/tmp/codex-exec
mkdir -p /bot/config /bot/work/downloads /bot/work/out /bot/work/uploads /bot/run /tmp/cache /tmp/codex-exec
echo "computer-ready $(date +%s%3N)" >&2
# Reachable only on this bot's own network, where the only other member is the brain.
if [ "$#" -gt 0 ]; then exec "$@"; else exec codex exec-server --listen ws://0.0.0.0:7700; fi
