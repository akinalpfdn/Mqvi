# Self-hosting mqvi

Two ways to self-host, depending on how much you want to run.

| Mode | You run | Accounts live on | Good for |
|---|---|---|---|
| [Voice server only](#voice-server-only) | a LiveKit SFU | mqvi.net | keeping calls off our infrastructure with almost no setup |
| [Full server](#full-server) | everything | your server | complete independence |

---

## Voice server only

Use your mqvi.net account normally — create servers, add friends, chat. The only difference is that
voice and video traffic goes through **your** LiveKit server instead of ours.

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
```

### Windows

Run PowerShell as Administrator:

```powershell
irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
```

The script downloads LiveKit, opens firewall ports (and attempts UPnP port forwarding on Windows),
generates API credentials, writes `livekit.yaml`, and installs it as a service that starts on boot.

**Requirements:** any Linux server or a Windows 10/11 machine. 1 GB RAM and 1 CPU core is enough.
If you use your own PC it has to stay on and reachable.

When it finishes you get three values:

| Value | Example |
|---|---|
| URL | `ws://203.0.113.10:7880` |
| API Key | `LiveKitKeyf3a1b2c4` |
| API Secret | `aBcDeFgHiJkLmNoPqRsTuVwXyZ012345` |

In mqvi, create a server, choose **Self-Hosted**, and paste them in.

---

## Full server

Everything on your own infrastructure: accounts, messages, files, voice.

### Requirements

- Linux, x86_64 or arm64 (Ubuntu 22.04+ / Debian 12+ recommended)
- 2 vCPU, 4 GB RAM minimum
- A domain is optional — without one the installer uses a free `sslip.io` hostname so HTTPS still
  works. Browsers block microphone, camera and screen share over plain HTTP, so TLS is not optional
  in practice.

### One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

You will be asked how to expose mqvi:

1. **HTTPS with your own domain** (recommended) — Caddy + Let's Encrypt, configured for you.
2. **HTTPS via sslip.io** — no domain needed. A hostname like `1-2-3-4.sslip.io` is derived from your
   public IP and gets a real certificate. Voice and video work.
3. **HTTP only** — testing only. Browsers will block media capture.

Non-interactive:

```bash
# your own domain, custom internal port
sudo bash install.sh --domain demo.example.com --port 9092 -y

# sslip.io fallback, all defaults
sudo bash install.sh -y

# HTTP only, custom port
sudo bash install.sh --no-tls --port 8080 -y

# force "existing Caddy" mode if detection fails
sudo bash install.sh --domain demo.example.com --existing-caddy -y
```

### What the installer does

1. Creates a dedicated `mqvi` system user and `/opt/mqvi`
2. Downloads the prebuilt `mqvi-server` binary for your architecture — everything is embedded, so no
   Go, Node.js or Docker is required
3. Downloads the LiveKit SFU binary
4. Generates `.env` and `livekit.yaml` with random secrets
5. Installs systemd units for both services, hardened (`ProtectSystem=strict`, `NoNewPrivileges`,
   `PrivateTmp`, dedicated user, `Restart=on-failure`)
6. Installs and configures Caddy — or, if Caddy is already running, leaves it alone and prints a
   snippet for you
7. Opens firewall ports (UFW / firewalld, if present)
8. Starts both services, enabled on boot

**Re-running is safe.** An existing `.env` and `livekit.yaml` are preserved so your secrets do not
change; flags will not overwrite them.

The installer prints your public URL when it finishes. **The first account to register becomes the
server owner.**

### Managing the services

```bash
# logs
journalctl -u mqvi-server -f
journalctl -u mqvi-livekit -f

# restart / stop
systemctl restart mqvi-server
systemctl stop mqvi-server mqvi-livekit

# update to the latest release
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
systemctl restart mqvi-server
```

### Backups

Everything you care about is in `/opt/mqvi/data/` — the SQLite database and uploaded files. Back up
that directory.

The database is in WAL mode, so copy `mqvi.db`, `mqvi.db-wal` and `mqvi.db-shm` together, or stop the
service first. `/opt/mqvi/.env` holds your secrets; losing `ENCRYPTION_KEY` means the stored LiveKit
credentials cannot be decrypted.

### Existing Caddy

If you already run Caddy, the installer detects it and prints a snippet like this for your
`Caddyfile`:

```
demo.example.com {
    reverse_proxy 127.0.0.1:9092
    encode zstd gzip
    request_body {
        max_size 30MB
    }
}
```

Then `sudo systemctl reload caddy`.

### Firewall ports

Opened automatically if UFW or firewalld is active. If your provider has its own firewall (Hetzner
Cloud Firewall, AWS Security Groups, …) open them there too.

| Port | Protocol | Purpose |
|---|---|---|
| `80` | TCP | Let's Encrypt challenge + HTTPS redirect (TLS modes) |
| `443` | TCP | HTTPS (TLS modes) |
| `<--port>` | TCP | Web UI + API — public only in `--no-tls` mode, otherwise localhost behind Caddy |
| `7880` | TCP | LiveKit signalling |
| `7881` | TCP | LiveKit TURN relay |
| `7882` | UDP | LiveKit media |
| `50000–50200` | UDP | LiveKit ICE candidates |

### Configuration

Edit `/opt/mqvi/.env` and `systemctl restart mqvi-server`. See
[`deploy/.env.example`](deploy/.env.example) for everything.

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_HOST` | `127.0.0.1` (TLS) / `0.0.0.0` (no-TLS) | bind address |
| `SERVER_PORT` | `9090` | internal HTTP port (`--port` at install) |
| `CORS_ORIGINS` | generated | your public URL |
| `JWT_SECRET` | generated | token signing |
| `ENCRYPTION_KEY` | generated | AES-256 key for stored LiveKit credentials — **required** |
| `MQVI_SIGNED_URL_SECRET` | generated | signs file URLs |
| `DATABASE_PATH` | `/opt/mqvi/data/mqvi.db` | SQLite file |
| `UPLOAD_DIR` | `/opt/mqvi/data/uploads` | uploaded files |
| `UPLOAD_MAX_SIZE` | `26214400` | max upload in bytes (25 MB) |
| `LIVEKIT_URL` | `ws://127.0.0.1:7880` | seeds a LiveKit instance on first start |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | generated | must match `livekit.yaml` |

Optional, with sensible defaults: `MQVI_ANTIVIRUS_*` and `MQVI_CLAMAV_ADDR` (ClamAV scanning of
uploads), `MQVI_WS_MAX_CONNECTIONS_PER_USER` (10) and `MQVI_WS_CONNECTS_PER_MINUTE` (60),
`MQVI_DEFAULT_QUOTA_BYTES` (per-user storage quota), `MQVI_PASSWORD_BREACH_CHECK`.

`ENCRYPTION_KEY` is the only one the server refuses to start without.

### Health checks

- `GET /api/health` — liveness, safe to expose to an uptime monitor
- `GET /health/ready` — deeper check (database, hub, push), bound to loopback only

Use an **external** uptime monitor. A check running on the same server cannot tell you the server is
down.

---

## Bandwidth

Worth planning for before you pick a host, because it is the constraint that actually bites.

Voice is cheap. **Screen sharing is the entire budget.** An SFU relays: one 1080p share with four
viewers is roughly 12 Mbps outbound, which is about 185 hours on a 1 TB monthly allowance. A share
nobody opens costs nothing at all — encoding is paused until someone chooses to watch.

Rough figures, egress only:

| Scenario | Rate |
|---|---|
| Voice, 5 in a channel, 1–2 speaking | ~0.6 Mbps |
| Voice, 20 in a channel, 2 speaking | ~3.6 Mbps |
| One 1080p share, 4 watching | ~12 Mbps |
| One 720p share, 4 watching | ~6 Mbps |

Nothing in mqvi polls your provider's bandwidth counters, so going over an allowance is invisible
until the invoice. If your host has a small allowance, set up an alert there.

---

## Troubleshooting

| Problem | Where to look |
|---|---|
| Voice does not connect | Ports closed. `sudo ufw status`, and check your provider's firewall separately |
| Connected but no audio | UDP 50000–50200 blocked |
| "Connection refused" | `systemctl status mqvi-livekit` |
| Works on LAN, not outside | `use_external_ip: true` in `livekit.yaml`; on Windows check router port forwarding |
| Server will not start | `journalctl -u mqvi-server -n 50` — config errors name the offending line |
| Media capture blocked in the browser | You are on plain HTTP. Browsers require HTTPS for microphone, camera and screen share |

Logs also surface in the app itself: platform administrators get a log view with levels and
categories, which is usually faster than SSH for diagnosing a user-visible problem.
