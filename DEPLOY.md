# Deploying to a public domain

The app is one Node process plus one SQLite database file. It needs a server with a **persistent disk**, so
serverless hosts (Vercel, Netlify, Cloudflare Pages) will not work. The recommended setup is a small Linux server
(VPS) running Docker. [Caddy](https://caddyserver.com) sits in front and fetches and renews free HTTPS
certificates for your domain automatically.

**Cost:** about US$5–12 a month for the server, plus your domain.

```
browser ──HTTPS──▶ Caddy (ports 80/443, automatic certificates) ──▶ app (port 3000) ──▶ /data/accreditation.db
                                                                                      └▶ /data/backups/ (daily)
```

## 1. Get a server

Any provider works, for example DigitalOcean, Hetzner, Linode, Vultr or AWS Lightsail. Choose:

- **Ubuntu 24.04 LTS**
- **1 vCPU, 2 GB RAM, 25 GB+ disk.** This is plenty for several thousand attendees and a handful of gates.
- **A region close to the venue**, for example Europe (London/Frankfurt) or a provider with a Lagos/Johannesburg region, so the gate stays responsive
- **An SSH key** for login

Note the server's **public IPv4 address**.

## 2. Point your domain at it

At your domain registrar or DNS provider, add an **A record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `accreditation` (or `@` for the bare domain) | your server's IPv4 | 300 |

This example gives you `accreditation.yourdomain.com`. Wait until `ping accreditation.yourdomain.com` shows the server's IP;
this usually takes a few minutes. If you use Cloudflare, set the record to **DNS only** (grey cloud) for the first start so Caddy can get its certificate.

## 3. Install Docker and open the firewall

SSH into the server (`ssh root@YOUR_IP`) and run:

```bash
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 4. Get the code onto the server

The repository is private, so use one of these:

- **Deploy key (recommended):** on the server run `ssh-keygen -t ed25519 -f ~/.ssh/deploy -N ""` and `cat ~/.ssh/deploy.pub`.
  In GitHub, go to the repository, then **Settings → Deploy keys → Add key** (read-only), and paste the key. Then run:
  ```bash
  GIT_SSH_COMMAND="ssh -i ~/.ssh/deploy" git clone -b main git@github.com:othellz/Accreditation-Build.git /opt/accreditation
  ```
- **Or** create a fine-grained GitHub token with read access to this repo, then run
  `git clone https://<token>@github.com/othellz/Accreditation-Build.git /opt/accreditation`.

Replace `main` with the branch you deploy from. The code currently sits on `claude/cool-wright-dtqm1b` until it is merged.

## 5. Configure and start

```bash
cd /opt/accreditation
cp .env.example .env
nano .env          # set DOMAIN, and set SETUP_TOKEN to the output of: openssl rand -hex 16
docker compose up -d --build
docker compose logs -f   # wait for "certificate obtained successfully", then Ctrl+C
```

Open `https://accreditation.yourdomain.com`. The first-run screen asks for the **setup code**, which is your `SETUP_TOKEN`.
Create your Admin account and the event there, then invite the Reviewer and Accreditors from **Users**.

> Do not run `npm run seed` on the live server. Its demo accounts use a public password.

## 6. Backups

- The app writes a database backup to `/data/backups` when it starts and then every 24 hours. It keeps 14 (`BACKUP_KEEP`).
- Copy backups off the server regularly. On your own computer you can run:
  ```bash
  ssh root@YOUR_IP "cd /opt/accreditation && docker compose cp app:/data/backups /root/backups-copy" \
    && scp -r root@YOUR_IP:/root/backups-copy ./accreditation-backups
  ```
- Also turn on your provider's **automatic server snapshots** (usually around US$1–2 a month).
- During the event, also use **Event → Export Excel** at the end of each day.

**To restore** a backup:

```bash
docker compose stop app
docker compose cp ./accreditation-2026-12-20T00-00-00.db app:/data/accreditation.db
docker compose start app
```

## 7. Updating

```bash
cd /opt/accreditation && git pull && docker compose up -d --build
```

Updates cause a few seconds of downtime. As the PRD requires, **freeze deploys during the event window (20–25 Dec)**. Ship
the final version and do the full dry run before then.

## Checklist before the event

- [ ] `https://` loads, and the padlock shows a valid certificate
- [ ] Admin account created; Reviewer and Accreditor invites sent and accepted
- [ ] Event days are 20–25 Dec 2026, and both groups exist
- [ ] Real zone definitions and wristband types loaded
- [ ] Dry run: upload two real company files, zone and publish them, check in from two phones, and match the reconciliation counts
- [ ] Backup copied off the server and a restore tested once
- [ ] Gate devices tested on the venue's actual internet (mobile data or Wi-Fi)

## Alternative: managed platform (no server to look after)

Platforms with persistent volumes also work with the included `Dockerfile`, for example **Render** (web service plus disk), **Railway**
(service plus volume) or **Fly.io** (app plus volume). On any of them:

- Mount the volume at `/data`. The defaults already store the database and backups there.
- Set the environment variables `SECURE_COOKIES=1`, `SETUP_TOKEN=<secret>` and `EVENT_TZ=Africa/Lagos`.
- Run **one instance only**, because SQLite does not support several servers writing at once.
- Add your custom domain in the platform's dashboard and create the DNS record it gives you. The platform handles HTTPS, so you don't need Caddy.
