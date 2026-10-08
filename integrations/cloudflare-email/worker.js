// Cloudflare Email Worker for Pitcrew member addresses (<handle>@PITCREW_MAIL_DOMAIN). Email Routing hands each
// message here; it is parsed and POSTed to Pitcrew's /api/mail, signed Standard Webhooks style (HMAC-SHA256 over
// "id.timestamp.body") with PITCREW_MAIL_SECRET, the value Settings → Email shows. Pitcrew decides who may wake whom.
import PostalMime from "postal-mime";

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function sign(secret, id, ts, body) {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `v1,${b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))}`;
}

export default {
  async email(message, env) {
    const mail = await PostalMime.parse(message.raw);
    const text = mail.text || (mail.html || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const body = JSON.stringify({
      to: message.to, from: message.from, subject: mail.subject || "",
      text: text.slice(0, 20000),
      attachments: (mail.attachments || []).map((a) => ({ name: a.filename || "file", size: a.content?.byteLength || 0 })),
    });
    const id = `msg_${crypto.randomUUID()}`, ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(env.PITCREW_MAIL_URL, { method: "POST", body, headers: {
      "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": await sign(env.PITCREW_MAIL_SECRET, id, ts, body),
    } });
    if (!res.ok) message.setReject(`Pitcrew didn't take it (${res.status})`);
  },
};
