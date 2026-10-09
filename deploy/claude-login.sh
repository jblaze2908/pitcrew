#!/usr/bin/env bash
# Signs Claude Code in with your own Claude plan, so crew members can hand it coding tasks (delegate_to_claude_code).
# Run once on the server, from your Pitcrew folder. The login stays in $PITCREW_ROOT/claude; Pitcrew only checks it exists.
set -euo pipefail
ROOT="${PITCREW_ROOT:-/srv/pitcrew}"
IMAGE="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' pitcrew-app | sed -n 's/^PITCREW_COMPUTER_IMAGE=//p')"
[[ -n "$IMAGE" ]] || { echo "pitcrew-app isn't running; start Pitcrew first." >&2; exit 1; }
# Owned by the crew uid (1500): Claude Code refreshes the login from inside its run containers.
install -d -o 1500 -g 1500 -m 700 "$ROOT/claude"
echo "Open the link Claude Code prints, sign in with your Claude account, and paste the code back here."
exec docker run --rm -it -u 1500:1500 -e HOME=/tmp -e CLAUDE_CONFIG_DIR=/claude -v "$ROOT/claude:/claude" --entrypoint claude "$IMAGE" auth login
