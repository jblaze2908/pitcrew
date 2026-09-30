# One crew member's computer: virtual desktop, Chromium, live view socket, Codex app-server and its MCP tools.
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
COPY computer-mcp.mjs /opt/pitcrew/computer-mcp.mjs
RUN chmod 755 /usr/local/bin/pitcrew-computer && chmod 644 /opt/pitcrew/computer-mcp.mjs
USER crew
WORKDIR /bot/work
ENV DISPLAY=:1 CODEX_HOME=/bot/codex TZ=Asia/Kolkata
ENTRYPOINT ["/usr/local/bin/pitcrew-computer"]
