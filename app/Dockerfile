# Pitcrew control plane. Zero npm dependencies; the Docker CLI drives the crew's computers through the host socket.
ARG COMPUTER_IMAGE=pitcrew-computer:1
FROM docker:29-cli AS dockercli
FROM ${COMPUTER_IMAGE} AS computer

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
# noVNC client files for the live view, from the same package the computers run.
COPY --from=computer /usr/share/novnc /usr/share/novnc
# The computers' managed Chrome policy, so the control plane can add each member's blocked domains (domains.mjs).
COPY --from=computer /etc/opt/chrome_for_testing/policies/managed/pitcrew.json /app/chrome-policy.json
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
ENV NODE_ENV=production TZ=Asia/Kolkata PORT=8330
EXPOSE 8330
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8330/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
