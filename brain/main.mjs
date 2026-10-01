// The brain container's long-running process: the LLM proxy and the exec gateway, both on loopback.
// Codex app-servers (one per active crew member) are started next to it by the control plane via `docker exec`.
import "./llm-proxy.mjs";
import "./exec-gateway.mjs";
console.error(`brain ready ${new Date().toISOString()}`);
