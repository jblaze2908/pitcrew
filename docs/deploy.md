# Deploy Pitcrew

Any Linux machine with Docker works: a VPS, a cloud VM, a home server. Pitcrew needs root on it, because the control plane starts crew computers through the Docker socket.

## Requirements

| | |
|---|---|
| OS | Linux x86_64 with Docker Engine and Docker Compose v2 (arm64 is untested) |
| RAM | The control plane and brain are small at rest (measured ~70 MiB and ~12 MiB; the brain is capped at 2 GB and grows with active members), plus ~300 MiB per running crew computer at idle, more while a browser works. The reference host is 2 vCPU / 8 GB with up to three computers at once. |
| Disk | Room for four images (the computer image alone is ~3 GB) plus workspaces and browser profiles under `/srv/pitcrew` |
| Network | A hostname pointing at the machine and a reverse proxy with TLS. Pitcrew listens only on the Docker bridge (`172.17.0.1:8330`) and opens no public port. |
| Models | An OpenRouter or Vercel AI Gateway key, or a ChatGPT plan |

Isolation note: computers are hardened containers (no capabilities, read-only root, own network). Kernel-level isolation (gVisor, microVMs) is not set up; treat the host as dedicated to Pitcrew.

## 1. Configure

```sh
git clone https://github.com/jblaze2908/pitcrew /opt/pitcrew
install -d -m 700 /etc/pitcrew
cp /opt/pitcrew/.env.example /etc/pitcrew/pitcrew.env && chmod 600 /etc/pitcrew/pitcrew.env
$EDITOR /etc/pitcrew/pitcrew.env
```

Set at least `PITCREW_HOST` (your hostname, without `https://`) and `PITCREW_TZ` (an IANA zone such as `Europe/Berlin`; schedules and day totals use it). Every key is described in [`.env.example`](../.env.example). Model keys are not set here; they go in Settings and are stored encrypted.

## 2. Build and start

**Option A: pull-based, with automatic updates (recommended).** A systemd timer checks `main` every 2 minutes, builds per-commit images, starts them, health-checks, and rolls back to the previous images if the check fails.

```sh
cp /opt/pitcrew/deploy/pitcrew.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pitcrew.timer
systemctl start pitcrew.service          # first build takes several minutes; the computer image is the slow one
journalctl -u pitcrew.service -f         # follow it
```

To stay on a fork or a branch, point `/opt/pitcrew`'s `origin` at it or set `DEPLOY_BRANCH` in the service. For an SSH remote, the script uses the deploy key at `GIT_SSH_COMMAND` (default `/root/.ssh/pitcrew_deploy`).

**Option B: build and run by hand.**

```sh
cd /opt/pitcrew
docker build -t pitcrew-computer:1 computer
docker build -t pitcrew-px0:1 px0
docker build --build-arg COMPUTER_IMAGE=pitcrew-computer:1 -t pitcrew-brain:1 harness
docker build --build-arg COMPUTER_IMAGE=pitcrew-computer:1 -t pitcrew-app:1 app
docker compose -p pitcrew -f deploy/compose.yml --env-file /etc/pitcrew/pitcrew.env up -d
curl -s http://172.17.0.1:8330/healthz    # 200 when up
```

The compose file uses tag `1` unless `PITCREW_TAG`, `PITCREW_COMPUTER_TAG` and `PITCREW_CODE_TAG` say otherwise.

## 3. Reverse proxy with TLS

Point your hostname at `172.17.0.1:8330`. Keep the `Host` header and pass WebSocket upgrades: the live view of a crew computer is a WebSocket, and Pitcrew rejects it unless `Origin` matches `Host`.

Caddy (automatic certificates):

```
pitcrew.example.com {
    reverse_proxy 172.17.0.1:8330
}
```

nginx (certificates from certbot or similar):

```nginx
server {
    listen 443 ssl;
    server_name pitcrew.example.com;
    ssl_certificate     /etc/letsencrypt/live/pitcrew.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pitcrew.example.com/privkey.pem;
    client_max_body_size 50m;
    location / {
        proxy_pass http://172.17.0.1:8330;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}
```

Traefik (file provider):

```yaml
http:
  routers:
    pitcrew:
      rule: Host(`pitcrew.example.com`)
      entryPoints: [websecure]
      service: pitcrew
      tls: { certResolver: letsencrypt }
  services:
    pitcrew:
      loadBalancer:
        servers: [{ url: "http://172.17.0.1:8330" }]
```

If your proxy runs in Docker on its own network, give it a route to the bridge address or attach it to the default bridge.

## 4. First run

1. Open `https://<PITCREW_HOST>`.
2. Paste the setup token: `cat /srv/pitcrew/data/setup-token`.
3. Choose a password. The token stops working once setup is done.
4. Settings → Models → Keys and sign-in: add an OpenRouter or Vercel AI Gateway key (tested before it is saved), or sign in with a ChatGPT plan by device code.
5. Hire the first crew member, give it a job, and watch its computer start.

## Optional integrations

**Phone push.** Settings → Notifications → Phone takes an [ntfy](https://ntfy.sh) topic URL. Pit stops arrive with Approve and Deny buttons; failed scheduled runs arrive too.

**Email for crew members.** Each member can get an address on a domain you control. With Cloudflare Email Routing, deploy the worker in [`integrations/cloudflare-email`](../integrations/cloudflare-email) and set `PITCREW_MAIL_DOMAIN` to the routed subdomain. Any mail service that can POST a signed webhook to `/api/mail` works the same way; see the worker for the format.

**Claude Code for coding tasks.** With a Claude Pro, Max, Team or Enterprise plan, run `sudo bash deploy/claude-login.sh` once from your Pitcrew folder and sign in. Members then get `delegate_to_claude_code`: Pitcrew runs the unmodified Claude Code CLI in a throwaway container over that member's workspace, its commands pass the member's safety check, and its questions come to you as pit stops. The login stays in `/srv/pitcrew/claude`, which no member computer mounts; Pitcrew only checks that it exists. Usage counts against your plan's limits.

**Shared memory (Engram).** If you run an [Engram](https://github.com/jblaze2908/engram) server, Settings → Shared memory takes its address and a link token; members then read and file memories there and its MCP gateway serves their connectors. `PITCREW_ENGRAM_URL` pre-fills the address. Without it, members keep per-member memory and MCP connections in Pitcrew.

## Updating

- Option A updates itself within ~2 minutes of a push to the tracked branch. The database is snapshotted to `/srv/pitcrew/data/backups/` before each rollout (last 14 kept).
- Option B: `git pull`, rebuild the images that changed, `docker compose … up -d`.

## Backups

Everything lives under `/srv/pitcrew`: `data/` (database, master key, setup token), `bots/<id>/` (workspaces, browser profiles), `brains/` (agent homes). Back up the whole folder; the master key in `data/` decrypts stored secrets, so keep backups as private as the host.

## Troubleshooting

| Symptom | Check |
|---|---|
| `set PITCREW_HOST in /etc/pitcrew/pitcrew.env` on start | The env file is missing or lacks `PITCREW_HOST`. |
| Health check fails, rollback in the journal | `docker logs pitcrew-app` and `docker logs pitcrew-brain`. |
| Live view stays black or reconnects | The proxy drops WebSocket upgrades or rewrites `Host`. |
| Schedules fire at the wrong hour | `PITCREW_TZ` is unset (UTC) or not an IANA name; restart after changing it. |
| Computers won't start or stop each other | RAM: lower `PITCREW_MAX_COMPUTERS` or add memory. |
| A first build times out | The computer image builds Chromium layers; the service allows 30 minutes. |
