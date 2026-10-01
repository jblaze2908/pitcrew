#!/bin/sh
# Stage 2: virtual desktop, Chromium (CDP on loopback), pointer extension and live-view socket. Idempotent.
set -eu
export DISPLAY=:1 HOME=/home/crew XDG_CONFIG_HOME=/bot/config XDG_CACHE_HOME=/tmp/cache
cdp() { node -e 'fetch("http://127.0.0.1:9222/json/version").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; }
if cdp; then echo "desktop-up"; exit 0; fi
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p /bot/profile/Default /bot/run
[ -e /tmp/.X11-unix/X1 ] || rm -f /bot/run/vnc.sock
rm -f /bot/profile/SingletonLock /bot/profile/SingletonSocket /bot/profile/SingletonCookie
# Downloads land in the workspace so they show up in Library.
[ -f /bot/profile/Default/Preferences ] || printf '%s' '{"download":{"default_directory":"/bot/work/downloads","prompt_for_download":false},"savefile":{"default_directory":"/bot/work/downloads"}}' > /bot/profile/Default/Preferences
# The container is stopped, not Chrome closed: mark the last exit clean so there's no "Restore pages?" bubble.
node -e 'const f="/bot/profile/Default/Preferences",fs=require("fs");try{const p=JSON.parse(fs.readFileSync(f,"utf8"));p.profile={...(p.profile||{}),exit_type:"Normal",exited_cleanly:true};fs.writeFileSync(f,JSON.stringify(p))}catch{}'
# The pointer extension gets this crew member's hue and name (JSON-encoded, never shell-interpolated).
rm -rf /tmp/pointer && cp -r /opt/pitcrew/pointer /tmp/pointer
node -e 'require("fs").writeFileSync("/tmp/pointer/config.js", "globalThis.PC_POINTER = " + JSON.stringify({ hue: process.env.PITCREW_HUE || "#4f7dff", name: process.env.PITCREW_NAME || "Crew" }) + ";\n")'
# Read-only view of /bot/work for the browser (file:// is blocked); exits at once if it is already listening.
node /opt/pitcrew/files.mjs >/tmp/files.log 2>&1 &
# No procps in the image: the X socket and the VNC socket say what's already running.
if [ ! -e /tmp/.X11-unix/X1 ]; then
  Xvfb :1 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
  openbox >/tmp/openbox.log 2>&1 &
fi
CHROME=$(ls -d /ms-playwright/chromium-*/chrome-linux64/chrome | head -1)
# Chrome's own sandbox needs user namespaces, which the container denies; the container is the boundary.
"$CHROME" --no-sandbox --disable-crash-reporter --disable-breakpad --disable-gpu --no-first-run --no-default-browser-check --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --load-extension=/tmp/pointer --disable-features=DisableLoadExtensionCommandLineSwitch \
  --disable-background-networking --disable-default-apps --disable-sync --metrics-recording-only \
  --test-type --disable-infobars --hide-crash-restore-bubble --disable-session-crashed-bubble \
  --user-data-dir=/bot/profile --window-position=0,0 --window-size=1280,800 --start-maximized about:blank >/tmp/chrome.log 2>&1 &
[ -S /bot/run/vnc.sock ] || { x11vnc -display :1 -forever -shared -nopw -rfbport 0 -unixsock /bot/run/vnc.sock -quiet >/tmp/vnc.log 2>&1 & }
# One poller (50 ms steps, 30 s cap) instead of a node process plus a 250 ms sleep per probe.
node -e 'const end=Date.now()+30000,p=()=>fetch("http://127.0.0.1:9222/json/version").then(r=>{if(!r.ok)throw 0;process.exit(0)}).catch(()=>Date.now()>end?process.exit(1):setTimeout(p,50));p()' \
  && echo "desktop-up" || { echo "desktop failed: $(tail -3 /tmp/chrome.log)"; exit 1; }
