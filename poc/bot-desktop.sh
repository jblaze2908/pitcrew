#!/bin/sh
# Boots the bot's desktop, then runs the given command (or idles as a live computer).
set -eu
export DISPLAY=:1 HOME=/home/probe XDG_CONFIG_HOME=/bot/config XDG_CACHE_HOME=/tmp/cache
mkdir -p -m 1777 /tmp/.X11-unix && mkdir -p /bot/config /tmp/cache
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
openbox >/tmp/openbox.log 2>&1 &
CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
# Chrome's own sandbox needs user namespaces, which the container denies; the container is the boundary.
"$CHROME" --no-sandbox --disable-crash-reporter --disable-breakpad --disable-gpu --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --user-data-dir=/bot/profile --window-position=0,0 --window-size=1280,800 about:blank >/tmp/chrome.log 2>&1 &
# Live view for the driver: VNC bound to localhost inside the box, noVNC on 6080.
x11vnc -display :1 -forever -shared -localhost -nopw -rfbport 5900 -quiet >/tmp/vnc.log 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
for i in $(seq 1 80); do xdotool search --onlyvisible --name "about:blank" >/dev/null 2>&1 && break; sleep 0.25; done
echo "desktop-ready $(date +%s%3N)"
if [ "$#" -gt 0 ]; then exec "$@"; else exec sleep infinity; fi
