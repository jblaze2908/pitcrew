// Spike: Codex app-server (brain) with native tools executing in a remote exec-server (computer).
import { spawn } from "node:child_process";
const EXEC_URL = process.env.EXEC_URL;
const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", id = 1; const pending = new Map(), seen = { approvals: [], deltas: 0, items: [] };
p.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
p.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.startsWith("{")) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method) {
      seen.approvals.push(`${m.method}: ${String(m.params.command || m.params.reason || "").slice(0, 80)}`);
      const result = m.method.includes("elicitation") ? { action: "accept", content: {}, _meta: null } : { decision: "accept" };
      p.stdin.write(JSON.stringify({ id: m.id, result }) + "\n");
    } else if (m.id !== undefined) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); }
    else if (m.method === "item/commandExecution/outputDelta") seen.deltas++;
    else if (m.method === "item/completed") { const it = m.params.item; if (["commandExecution", "fileChange", "agentMessage"].includes(it.type)) seen.items.push(it); }
    else if (m.method === "turn/completed") seen.done?.(m.params.turn);
  }
});
const rq = (method, params) => new Promise((res, rej) => { const n = id++; pending.set(n, { res, rej }); p.stdin.write(JSON.stringify({ id: n, method, params }) + "\n"); });
await rq("initialize", { clientInfo: { name: "spike", title: "spike", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
p.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
const tA = Date.now();
console.log("dead add", JSON.stringify(await rq("environment/add", { environmentId: "dead", execServerUrl: "ws://10.255.255.1:7700", connectTimeoutMs: 3000 }).catch((e) => e.message.slice(0, 120))), `${Date.now() - tA}ms`);
console.log("dead status", JSON.stringify(await rq("environment/status", { environmentId: "dead" }).catch((e) => e.message.slice(0, 120))));
console.log("environment/add", JSON.stringify(await rq("environment/add", { environmentId: "computer", execServerUrl: EXEC_URL })));
console.log("status before use", JSON.stringify(await rq("environment/status", { environmentId: "computer" }).catch((e) => e.message.slice(0, 120))));
console.log("environment/info", JSON.stringify(await rq("environment/info", { environmentId: "computer" }).catch((e) => e.message)));
console.log(Date.now(), "thread/start");
const st = await rq("thread/start", { model: process.env.MODEL || "anthropic/claude-sonnet-5.5", modelProvider: process.env.PROVIDER || "openrouter", cwd: "/bot/work", sandbox: "danger-full-access", approvalPolicy: "untrusted" });
const t0 = Date.now();
if (process.env.CHAT_ONLY) {
  console.log(Date.now(), "turn/start (chat only)");
  const d0 = new Promise((r) => (seen.done = r));
  await rq("turn/start", { threadId: st.thread.id, environments: [{ environmentId: "computer", cwd: "/bot/work" }], input: [{ type: "text", text: "What is 17 times 3? Reply with just the number. Do not use tools.", text_elements: [] }] });
  console.log(Date.now(), "turn done", (await d0).status); p.kill(); process.exit(0);
}
const done = new Promise((r) => (seen.done = r));
await rq("turn/start", { threadId: st.thread.id, environments: [{ environmentId: "computer", cwd: "/bot/work" }], input: [{ type: "text", text: "Step 1: run `hostname; pwd; ls /bot/work` with the shell. Step 2: create /bot/work/spike.txt containing 'hello from the brain' using apply_patch (not the shell). Step 3: run `cat /bot/work/spike.txt; for i in 1 2 3; do echo tick $i; sleep 1; done`. Step 4: run `cat /brain/config.toml; ls /`. Reply with the hostname you saw and whether /brain/config.toml existed.", text_elements: [] }] });
const turn = await done;
console.log("turn", turn.status, `${Math.round((Date.now() - t0) / 1000)}s`);
for (const it of seen.items) console.log(" ", it.type, it.type === "commandExecution" ? `${it.command} → ${String(it.aggregatedOutput || "").replace(/\s+/g, " ").slice(0, 120)}` : it.type === "fileChange" ? JSON.stringify(it.changes.map((c) => c.path)) : it.text?.slice(0, 120));
console.log("approvals:", seen.approvals.length, seen.approvals.slice(0, 6).join(" | "));
console.log("output deltas streamed:", seen.deltas);
p.kill(); process.exit(0);
