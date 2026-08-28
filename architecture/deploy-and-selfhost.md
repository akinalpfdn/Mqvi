# Deployment and self-hosting

Verified against `main` at 2026-08-27, and against release **v2.24.0**.

## Two self-host modes

**Voice server only.** Use the hosted mqvi.net account normally; only voice/video traffic goes
through your own LiveKit. `deploy/livekit-setup.sh` (Linux) / `livekit-setup.ps1` (Windows) downloads
LiveKit, opens firewall ports, generates credentials, writes `livekit.yaml`, installs a service. The
operator then pastes URL + API key + secret into "Self-Hosted" when creating a server.

**Full server.** One command:

```
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

Note it fetches from **`main`**, not from the release asset — the identical file is also attached to
releases, but the advertised path is the branch.

## What `install.sh` actually does (630 lines)

Flags: `--domain`, `--port` (default 9090), `--no-tls`, `--existing-caddy`, `-y/--yes`.

1. Creates `/opt/mqvi` and a dedicated **`mqvi` system user** (not root).
2. Downloads `mqvi-server-linux-${ARCH}` from `releases/latest/download/`.
3. Downloads LiveKit (`LIVEKIT_VERSION` pinned in the script).
4. Generates `.env` with random `JWT_SECRET`, `ENCRYPTION_KEY`, `MQVI_SIGNED_URL_SECRET`.
5. Writes `livekit.yaml` with random API credentials, and puts the **same** credentials into `.env`
   as `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
6. Installs systemd units for both services, with `NoNewPrivileges=true`, `ProtectSystem=strict`,
   `ProtectHome=true`, `PrivateTmp=true`, `ReadWritePaths=/opt/mqvi`, `Restart=on-failure`.
7. Installs/configures **Caddy** for automatic Let's Encrypt; falls back to **sslip.io** when no
   domain is given; detects an existing Caddy and prints a snippet instead.
8. Opens firewall ports (UFW / firewalld).
9. Optionally fetches `coturn-setup.sh` for the P2P TURN relay.

**Re-running is safe** — an existing `.env` and `livekit.yaml` are preserved, and only missing
antivirus keys are back-filled via `ensure_env_value`.

### The seeding chain — why voice works out of the box

`main.go` (~line 409): when `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are all set, the
server encrypts the credentials with `ENCRYPTION_KEY` and **seeds a platform LiveKit instance**, then
links any server rows with a null `livekit_instance_id` to it. That is exactly the triple
`install.sh` writes, which is what makes the one-command install produce working voice.

**Trap:** the existence check is `GetLeastLoadedPlatformInstance`, which carries a **hard
`max_servers` filter**. It returns `ErrNotFound` when all instances are *full*, not only when none
exist — so an operator who sets `max_servers` and reaches it gets a duplicate instance seeded on
every restart. Pre-existing; `main` has the same filter. Not fixed.

The seeded instance gets **no region**, which migration 091 defaults to `''` (unknown). Correct — an
unknown instance stays usable, it is just never chosen for proximity.

## Configuration

`ENCRYPTION_KEY` is **required and fail-fast** at config load (64 hex chars = 32-byte AES-256), and
validated again by `crypto.DeriveKey` in `main.go`. Everything else has a default.

Config reads ~40 env keys. Groups: server (`SERVER_HOST`, `SERVER_PORT`, `APP_URL`,
`CORS_ORIGINS`), auth (`JWT_*`), storage (`DATABASE_PATH`, `UPLOAD_DIR`, `UPLOAD_MAX_SIZE`,
`MQVI_DEFAULT_QUOTA_BYTES`, `MQVI_PUBLIC_FILE_URL`, `MQVI_SIGNED_URL_SECRET`), antivirus
(`MQVI_ANTIVIRUS_*`, `MQVI_CLAMAV_ADDR`), WS limits (`MQVI_WS_MAX_CONNECTIONS_PER_USER` = 10,
`MQVI_WS_CONNECTS_PER_MINUTE` = 60), rate limits (`MQVI_FILE_RATE_*`), push (`FCM_CREDENTIALS_FILE`,
`APNS_*`, `MQVI_PUSH_*`), LiveKit, `HETZNER_API_TOKEN` (metrics only, **read-only** — it provisions
nothing), `KLIPY_API_KEY`, mobile app identifiers.

Config errors name the offending line (`fix(config): say which .env line is broken`).

**Port note:** the config default is **9090**, but production listens on **8080**. Do not assume the
default.

## Health and readiness

- `GET /api/health` — public liveness, reports a counter the operator watches the delta of.
- `GET /health/ready` — deep check (DB, hub, push) on its **own loopback listener**. Deliberately
  separate: behind the reverse proxy every request already arrives from 127.0.0.1, so path-based
  gating would not have restricted it. Disabled with a log line if it cannot bind.

## Zero-downtime deploy

PR#31 (`feature/zero-downtime-deploy`, 07-28). The server **signals clients on shutdown** with the
`server_shutdown` WS op so they can reconnect deliberately rather than discovering a dead socket, and
`main.go` does a graceful shutdown of both the main and readiness servers.

`deploy/systemd/` holds `mqvi-server.service`, `mqvi-livekit.service`, `install-units.sh`,
`bootstrap.sh`, `prestart.sh`, and a README. `deploy/caddy-zero-downtime.md` documents the proxy
side.

The deploy scripts back up the database and **gate on readiness before declaring a deploy done**
(`fix(deploy): back up the database and gate on readiness before calling a deploy done`). Also
`fix(deploy): stop the deploy script from killing the shell that runs it` — worth remembering if
editing them.

`deploy/redeploy*.{sh,ps1}` are **gitignored** and contain the real host; `redeploy.example.*` are
the tracked templates. Tracked deploy scripts take a `-Server` parameter with no real default —
this is a public repo.

## Cloudflare

The deployment sits behind Cloudflare.

- **`CF-IPCountry` is the geo signal** for voice routing, and it only exists if the hostname is
  proxied *and* Network → IP Geolocation is enabled. Otherwise every call silently falls back to the
  server's own instance and **nothing on the server reveals that** — there is no log line telling an
  operator whether the header arrived. See `docs/test-checklist-geo-voice-routing.md`.
- **HTTP/3 (QUIC) is disabled at Cloudflare** — decision 2026-07-20. Read that entry before
  re-enabling.

## Bandwidth — the real operating constraint

Worked out in `PHASE-141-GEO-06-active.md`. Hetzner includes **20 TB** at EU locations but only
**1 TB** at Ashburn/Hillsboro/Singapore. Egress only; inbound is not billed.

1 TB / 730 h = **3.04 Mbps sustained** for a whole month.

| Scenario (egress) | Rate | 1 TB lasts |
|---|---|---|
| Voice, 5 in channel, 1.5 speaking | 576 kbps | 3 858 h |
| Voice, 20 in channel, 2 speaking | 3.65 Mbps | 609 h |
| One 1080p share, 4 watching top layer | 12 Mbps | **185 h** |
| Any share, nobody watching | 0 | — |

**Voice is effectively free; screen share is the entire budget.** A share nobody opens costs nothing
at all — `dynacast` + `autoSubscribe: false` means encoding is paused until someone clicks to watch.
That is the single largest saving and it already exists.

**Nothing polls bandwidth.** `GetInstanceMetrics` pulls Hetzner counters only when an admin opens the
panel. Going over an allowance is invisible until the invoice.

## Server hardening baseline

The project's own rules require: non-root deploy user, SSH key-only, firewall limited to 22/80/443,
never expose DB ports, reverse proxy with automatic TLS, systemd with `Restart=on-failure` and
hardening flags, `EnvironmentFile` for secrets, a rollback path, unattended security upgrades, and
external uptime monitoring. `install.sh` already satisfies most of these.

## Known gaps

- **The one-command install has never been run end to end on a clean Linux server.** The chain is
  statically verified and coherent — README → `install.sh` → release assets → `.env` → seeding — but
  nobody has executed it. Claimed and coherent, not proved.
- `LIVEKIT_VERSION` is pinned at **v1.9.12**; current upstream is **v1.13.6**. A bump must be tested
  against `server-sdk-go/v2 v2.15.0` and `protocol v1.44.1`, not applied blind.
- No horizontal scaling: single instance, in-memory hub and voice state, SQLite file.
- No SSO (SAML/OIDC/SCIM), no tamper-evident audit log, no data-residency story — the usual
  enterprise gates.
- No drain mechanism for a LiveKit instance: migrating servers off it lowers its
  `live_server_count` and makes it *more* attractive for region-based call placement.
