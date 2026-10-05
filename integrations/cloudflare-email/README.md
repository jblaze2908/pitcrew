# Pitcrew member email (Cloudflare)

Gives each crew member an address like `billkeeper@pitcrew.example.com`.

1. Cloudflare dashboard → `example.com` → Email → Email Routing → enable it for the subdomain `pitcrew.example.com` (Cloudflare adds the MX and SPF records).
2. Deploy this worker: `npm install && npx wrangler deploy`, then `npx wrangler secret put PITCREW_MAIL_URL` and `npx wrangler secret put PITCREW_MAIL_SECRET` with the values from Pitcrew → Settings → Email → Show worker settings.
3. Email Routing → Routing rules → Catch-all for `pitcrew.example.com` → Send to a Worker → `pitcrew-email`.
4. In Pitcrew → Settings → Email, add your own addresses and give members an address and a sender list.

Pitcrew refuses anything not signed with the secret. Mail from someone not on a member's list waits for you in a pit stop.
