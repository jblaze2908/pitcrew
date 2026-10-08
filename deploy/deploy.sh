#!/bin/bash
# Production deploys are pull-based: the host's pitcrew.timer fetches main every 2 min and runs deploy/pull-update.sh.
# This just runs that same deploy now (after you've pushed to main) and shows the result.
set -euo pipefail
HOST=${PITCREW_SSH:?set PITCREW_SSH to the ssh host Pitcrew runs on}
ssh "$HOST" 'systemctl start pitcrew.service; systemctl --no-pager --lines=0 status pitcrew.service | head -3; journalctl -u pitcrew.service -n 15 --no-pager -o cat'
