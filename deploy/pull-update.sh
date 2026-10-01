#!/usr/bin/env bash
set -euo pipefail

# Pull-based deploy (same shape as Draft's): the host fetches main itself, so nothing outside it holds server access.
# Run by deploy/pitcrew.timer every 2 min; a no-op unless main moved or the stack is down.
# Images are tagged per commit, so a rollback restores the previous images exactly; the ~3 GB computer image is
# rebuilt only when computer/ changed.
DEPLOY_DIR="${DEPLOY_DIR:-/opt/pitcrew}"
BRANCH="${DEPLOY_BRANCH:-main}"
STATE_DIR="${PITCREW_STATE_DIR:-/var/lib/pitcrew}"
ENV_FILE="${PITCREW_ENV_FILE:-/etc/pitcrew/pitcrew.env}"
HEALTH_URL="${PITCREW_HEALTH_URL:-http://172.17.0.1:8330/healthz}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/pitcrew_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes}"

install -d -m 700 "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0

RELEASE="$STATE_DIR/release.env"   # PITCREW_TAG / PITCREW_COMPUTER_TAG of the running release
compose() { docker compose -p pitcrew -f deploy/compose.yml --env-file "$1" "${@:2}"; }

notify() {
  # Optional ops alerts; NTFY_* live in the root-only env file and are never echoed.
  [[ -f "$ENV_FILE" ]] || return 0
  url="$(sed -n 's/^NTFY_URL=//p' "$ENV_FILE" | tail -1)"; [[ -n "$url" ]] || return 0
  token="$(sed -n 's/^NTFY_TOKEN=//p' "$ENV_FILE" | tail -1)"
  curl --silent --max-time 10 ${token:+-H "Authorization: Bearer $token"} -d "pitcrew: $1" "$url" >/dev/null || true
}

cd "$DEPLOY_DIR"
deployed_commit="$(git rev-parse -q --verify refs/heads/deployed || true)"
git fetch --prune origin "$BRANCH"
target_commit="$(git rev-parse "origin/$BRANCH")"
short="${target_commit:0:8}"

running() { docker ps --format '{{.Names}}' | grep -qx pitcrew-app && docker ps --format '{{.Names}}' | grep -qx pitcrew-brain; }
if [[ "$deployed_commit" == "$target_commit" ]] && running; then exit 0; fi
# Don't rebuild a commit that already failed; a new push clears it.
if [[ "$(cat "$STATE_DIR/failed-commit" 2>/dev/null || true)" == "$target_commit" ]]; then exit 0; fi

reject() { echo "$target_commit" >"$STATE_DIR/failed-commit"; notify "❌ $short rejected: $1"; echo "rejected: $1" >&2; exit 1; }

git checkout --detach "$target_commit"
# Bash is still reading the pre-checkout copy of this script; rerun the new one so a release that changes the deploy steps gets them.
if [[ -z "${PITCREW_REEXEC:-}" ]] && ! git diff --quiet "${deployed_commit:-$target_commit}" "$target_commit" -- deploy/pull-update.sh; then
  PITCREW_REEXEC=1 exec bash "$DEPLOY_DIR/deploy/pull-update.sh"
fi
prev_computer="$(sed -n 's/^PITCREW_COMPUTER_TAG=//p' "$RELEASE" 2>/dev/null || true)"
computer_tag="$prev_computer"
if [[ -z "$deployed_commit" || -z "$prev_computer" ]] || ! docker image inspect "pitcrew-computer:$prev_computer" >/dev/null 2>&1 \
   || ! git diff --quiet "$deployed_commit" "$target_commit" -- computer/; then
  computer_tag="$short"
fi

# The read-only code view (px0) image, rebuilt only when px0/ changed, like the computer.
prev_code="$(sed -n 's/^PITCREW_CODE_TAG=//p' "$RELEASE" 2>/dev/null || true)"
code_tag="$prev_code"
if [[ -z "$deployed_commit" || -z "$prev_code" ]] || ! docker image inspect "pitcrew-px0:$prev_code" >/dev/null 2>&1 \
   || ! git diff --quiet "$deployed_commit" "$target_commit" -- px0/; then
  code_tag="$short"
fi

# Build everything before touching the running stack, so a broken build never takes the app down.
if [[ "$computer_tag" == "$short" ]]; then docker build -q -t "pitcrew-computer:$short" computer >/dev/null || reject "computer image build failed"; fi
if [[ "$code_tag" == "$short" ]]; then docker build -q -t "pitcrew-px0:$short" px0 >/dev/null || reject "code view image build failed"; fi
docker build -q --build-arg COMPUTER_IMAGE="pitcrew-computer:$computer_tag" -t "pitcrew-brain:$short" brain >/dev/null || reject "brain image build failed"
docker build -q --build-arg COMPUTER_IMAGE="pitcrew-computer:$computer_tag" -t "pitcrew-app:$short" app >/dev/null || reject "app image build failed"

# SQLite snapshot before the new code boots (schema changes run at boot and a rollback doesn't undo them).
install -d -m 700 /srv/pitcrew/data/backups
if running; then
  docker exec pitcrew-app node -e "new (require('node:sqlite').DatabaseSync)('/srv/pitcrew/data/pitcrew.db').exec(\"VACUUM INTO '/srv/pitcrew/data/backups/pre-$short.db'\")" 2>/dev/null || true
  ls -1t /srv/pitcrew/data/backups/pre-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
fi

next="$STATE_DIR/next.env"
printf 'PITCREW_TAG=%s\nPITCREW_COMPUTER_TAG=%s\nPITCREW_CODE_TAG=%s\n' "$short" "$computer_tag" "$code_tag" >"$next"
healthy() { for _ in {1..30}; do curl --fail --silent -m 5 "$HEALTH_URL" >/dev/null && return 0; sleep 3; done; return 1; }
rollback() {
  echo "Rolling back to $(cat "$RELEASE" 2>/dev/null | tr '\n' ' ')" >&2
  if [[ -f "$RELEASE" ]]; then compose "$RELEASE" up --detach --remove-orphans || true; fi
  git checkout --detach "${deployed_commit:-$target_commit}" || true
}
if ! compose "$next" up --detach --remove-orphans || ! healthy; then rollback; reject "rollout or health check failed"; fi

mv "$next" "$RELEASE"
git branch --force deployed "$target_commit"
rm -f "$STATE_DIR/failed-commit"
# Keep the last three releases' images for rollback.
for repo in pitcrew-app pitcrew-brain pitcrew-computer pitcrew-px0; do
  keep="$(grep -h "TAG=" "$RELEASE" | cut -d= -f2 | sort -u | tr '\n' '|')"
  docker image ls "$repo" --format '{{.Tag}} {{.CreatedAt}}' | sort -k2 -r | awk '{print $1}' | tail -n +4 | grep -Ev "^(${keep%|})$" | xargs -r -I{} docker image rm "$repo:{}" >/dev/null 2>&1 || true
done
notify "✅ deployed $short"
echo "deployed $short (computer $computer_tag, code view $code_tag)"
