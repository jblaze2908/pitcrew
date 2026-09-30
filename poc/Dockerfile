# Throwaway harness-probe image. Runs on the host beside production, so it stays self-contained.
FROM node:22-bookworm-slim

# Pinned to releases at least 7 days old (release-age cooldown).
# Codex (Rust) verifies TLS against the OS CA store; the slim base image ships without one.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
# Browser lives in a shared path so the non-root probe user finds it (the MCP server expects chrome-for-testing).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @openai/codex@0.156.1 @playwright/mcp@0.0.82 \
 && cd "$(npm root -g)/@playwright/mcp" \
 && npx playwright install-deps chromium \
 && npx @playwright/mcp install-browser chrome-for-testing \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm

RUN useradd -m -u 1500 probe
USER probe
WORKDIR /poc
ENV CODEX_HOME=/poc/.codex-home
