# The crew's brain: Codex app-servers (one per active crew member), the LLM proxy and the lazy exec gateway.
# Holds the model keys and the ChatGPT token; computers never do. Built on the computer image for the same Codex build.
FROM pitcrew-computer:1
USER root
RUN mkdir -p /opt/pitcrew/brain /brains /auth /run/pitcrew && chown crew /brains
COPY llm-proxy.mjs exec-gateway.mjs main.mjs /opt/pitcrew/brain/
RUN chmod -R a+rX /opt/pitcrew/brain
USER crew
WORKDIR /brains
ENV HOME=/home/crew
ENTRYPOINT []
CMD ["node", "/opt/pitcrew/brain/main.mjs"]
