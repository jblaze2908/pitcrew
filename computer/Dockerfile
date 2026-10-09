# One crew member's computer: Codex exec-server (shell + apply_patch), and on demand a desktop, Chromium and live view.
FROM node:22-bookworm-slim

# Pinned to releases at least 7 days old (release-age cooldown). Codex verifies TLS against the OS CA store.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Claude Code is the unmodified CLI that members hand coding tasks to (app/src/runtime/claude.ts), signed in with the
# driver's own Claude plan; its native binary comes from its postinstall.
RUN npm install -g @openai/codex@0.158.0 @playwright/mcp@0.0.82 @anthropic-ai/claude-code@2.1.287 \
 && claude --version \
 && cd "$(npm root -g)/@playwright/mcp" \
 && npx playwright install-deps chromium \
 && npx @playwright/mcp install-browser chrome-for-testing \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc novnc xdotool imagemagick fonts-dejavu-core fonts-noto-color-emoji tzdata git ripgrep curl jq \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1500 crew && mkdir -p /bot /auth /opt/pitcrew && chown crew /bot
COPY entrypoint.sh /usr/local/bin/pitcrew-computer
COPY desktop.sh /usr/local/bin/pitcrew-desktop
COPY computer-mcp.mjs files.mjs /opt/pitcrew/
COPY pointer /opt/pitcrew/pointer
# Managed Chrome policy: URL blocklist, private ranges via PAC (after DNS), no cert-error bypass. Chrome for Testing reads
# this dir (checked with chrome://policy, CfT 154; the grep fails the build if a new browser reads elsewhere). Root-owned,
# so the crew cannot edit it. Safe Browsing and DownloadRestrictions are set but inert here: CfT has no Google API keys
# and CDP-driven downloads bypass DownloadRestrictions (both measured). The control plane mounts a per-member copy over it.
COPY chrome-policy.json private-net.pac /opt/pitcrew/policy/
RUN P=/etc/opt/chrome_for_testing/policies/managed && mkdir -p "$P" \
 && grep -aq /etc/opt/chrome_for_testing/policies "$(ls -d /ms-playwright/chromium-*/chrome-linux64/chrome | head -1)" \
 && node -e 'const f=require("fs"),p=JSON.parse(f.readFileSync("/opt/pitcrew/policy/chrome-policy.json"));p.ProxySettings.ProxyPacUrl="data:application/x-ns-proxy-autoconfig;base64,"+f.readFileSync("/opt/pitcrew/policy/private-net.pac").toString("base64");f.writeFileSync(process.argv[1]+"/pitcrew.json",JSON.stringify(p))' "$P" \
 && chmod -R a+rX /etc/opt/chrome_for_testing
# Codex dispatches on argv[0]: an apply_patch link lets remote turns patch files here. It must be on the login-shell PATH.
RUN chmod 755 /usr/local/bin/pitcrew-computer /usr/local/bin/pitcrew-desktop && chmod -R a+rX /opt/pitcrew \
 && ln -s "$(npm root -g)/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" /usr/local/bin/apply_patch \
 && test -x /usr/local/bin/apply_patch
USER crew
WORKDIR /bot/work
ENV DISPLAY=:1 CODEX_HOME=/bot/codex TZ=UTC
ENTRYPOINT ["/usr/local/bin/pitcrew-computer"]
