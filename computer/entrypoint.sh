#!/bin/sh
# Boots the desktop, then execs the given command (the control plane runs `codex app-server`).
# stdout belongs to the JSON-RPC stream, so everything here logs to /tmp.
set -eu
export DISPLAY=:1 HOME=/home/crew XDG_CONFIG_HOME=/bot/config XDG_CACHE_HOME=/tmp/cache
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p /bot/config /bot/work/downloads /bot/work/out /bot/work/uploads /bot/profile/Default /bot/run /tmp/cache
rm -f /bot/run/vnc.sock /bot/profile/SingletonLock /bot/profile/SingletonSocket /bot/profile/SingletonCookie
# Downloads land in the workspace so they show up in Library.
[ -f /bot/profile/Default/Preferences ] || printf '%s' '{"download":{"default_directory":"/bot/work/downloads","prompt_for_download":false},"savefile":{"default_directory":"/bot/work/downloads"}}' > /bot/profile/Default/Preferences
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
openbox >/tmp/openbox.log 2>&1 &
CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
# Chrome's own sandbox needs user namespaces, which the container denies; the container is the boundary.
# CDP stays on the container's loopback: only this computer's Playwright MCP talks to it.
"$CHROME" --no-sandbox --disable-crash-reporter --disable-breakpad --disable-gpu --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/bot/profile --window-position=0,0 --window-size=1280,800 about:blank >/tmp/chrome.log 2>&1 &
# Live view: VNC only on a unix socket in /bot/run; the control plane bridges it to the authenticated browser.
x11vnc -display :1 -forever -shared -nopw -rfbport 0 -unixsock /bot/run/vnc.sock -quiet >/tmp/vnc.log 2>&1 &
for i in $(seq 1 80); do xdotool search --onlyvisible --name "about:blank" >/dev/null 2>&1 && break; sleep 0.25; done
echo "desktop-ready $(date +%s%3N)" >&2
if [ "$#" -gt 0 ]; then exec "$@"; else exec sleep infinity; fi
