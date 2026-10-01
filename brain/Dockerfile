# The crew's brain: Codex app-servers (one per active crew member), the LLM proxy and the lazy exec gateway.
# Holds the model keys and the ChatGPT token; computers never do. Built on the computer image for the same Codex build.
ARG COMPUTER_IMAGE=pitcrew-computer:1
FROM ${COMPUTER_IMAGE}
USER root
RUN mkdir -p /opt/pitcrew/brain /brains /auth /run/pitcrew && chown crew /brains
COPY llm-proxy.mjs exec-gateway.mjs main.mjs /opt/pitcrew/brain/
# App-servers run the native Codex binary directly (computer.mjs), with the env npm's node wrapper would have set.
RUN chmod -R a+rX /opt/pitcrew/brain \
 && ln -s "$(npm root -g)/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex" /opt/pitcrew/brain/codex \
 && test -x /opt/pitcrew/brain/codex && test "$(npm root -g)" = /usr/local/lib/node_modules
USER crew
WORKDIR /brains
ENV HOME=/home/crew CODEX_MANAGED_BY_NPM=1 CODEX_MANAGED_PACKAGE_ROOT=/usr/local/lib/node_modules/@openai/codex
ENTRYPOINT []
CMD ["node", "/opt/pitcrew/brain/main.mjs"]
