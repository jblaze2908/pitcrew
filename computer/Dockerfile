# One crew member's computer: Codex exec-server (shell + apply_patch), and on demand a desktop, Chromium and live view.
FROM node:22-bookworm-slim

# Pinned to releases at least 7 days old (release-age cooldown). Codex verifies TLS against the OS CA store.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @openai/codex@0.156.1 @playwright/mcp@0.0.82 \
 && cd "$(npm root -g)/@playwright/mcp" \
 && npx playwright install-deps chromium \
 && npx @playwright/mcp install-browser chrome-for-testing \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc novnc xdotool imagemagick fonts-dejavu-core fonts-noto-color-emoji tzdata \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1500 crew && mkdir -p /bot /auth /opt/pitcrew && chown crew /bot
COPY entrypoint.sh /usr/local/bin/pitcrew-computer
COPY desktop.sh /usr/local/bin/pitcrew-desktop
COPY computer-mcp.mjs /opt/pitcrew/
COPY pointer /opt/pitcrew/pointer
# Codex dispatches on argv[0]: an apply_patch link lets remote turns patch files here. It must be on the login-shell PATH.
RUN chmod 755 /usr/local/bin/pitcrew-computer /usr/local/bin/pitcrew-desktop && chmod -R a+rX /opt/pitcrew \
 && ln -s "$(npm root -g)/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" /usr/local/bin/apply_patch \
 && test -x /usr/local/bin/apply_patch
USER crew
WORKDIR /bot/work
ENV DISPLAY=:1 CODEX_HOME=/bot/codex TZ=Asia/Kolkata
ENTRYPOINT ["/usr/local/bin/pitcrew-computer"]
