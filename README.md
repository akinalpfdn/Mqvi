<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  Open-source communication platform with voice, video, and text.<br/>
  No identity verification. No data collection. Self-host ready.
</p>

<p align="center">
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.exe"><img src="icons/btn-windows.svg" alt="Download for Windows" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.dmg"><img src="icons/btn-macos.svg" alt="Download for macOS" height="48" /></a>&nbsp;&nbsp;
  <a href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.AppImage"><img src="icons/btn-linux.svg" alt="Download for Linux" height="48" /></a>
</p>

<p align="center">
  <a href="https://mqvi.net">Website</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="SELF-HOSTING.md">Self-Host</a> &middot;
  <a href="ARCHITECTURE.md">Architecture</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <a href="README.tr.md">🇹🇷 Türkçe</a>
</p>

<!--
  Screenshots go here. Suggested set, in this order:
    docs-assets/hero.png      — server + channel list + a busy chat, current theme
    docs-assets/voice.png     — voice channel with participants, one screen sharing
    docs-assets/mobile.png    — the same chat on a phone
    docs-assets/demo.gif      — join voice → speaking indicator → start screen share (10-15s)
-->

---

## Why mqvi?

Popular communication platforms are increasingly demanding government-issued IDs from their users.
After multiple data breaches, trusting them with your passport or national ID is a risk most people
shouldn't have to take.

**mqvi is built on a simple principle: your conversations should belong to no one but you.**

- No phone number or government ID required
- Zero data collection
- Full source code is public — don't trust, verify
- Self-host on your own server for complete control

---

## Run your own, in one command

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/install.sh | sudo bash
```

That is the whole thing. The installer creates a dedicated system user, fetches a prebuilt binary
with the frontend embedded, sets up a LiveKit SFU for voice and video, generates your secrets,
installs hardened systemd units, and configures Caddy with automatic HTTPS. No Go, Node.js or Docker
required. No domain required either — it falls back to a free `sslip.io` hostname and still gets a
real certificate, because browsers block microphone and screen share without HTTPS.

The first account to register becomes the owner.

Prefer to keep your account on mqvi.net and only move **voice traffic** to your own machine? That is
a one-line install too. Both modes: **[SELF-HOSTING.md](SELF-HOSTING.md)**.

---

## Features

**Communication** — text channels with file sharing, editing and typing indicators; low-latency
voice and video over a self-hosted [LiveKit](https://livekit.io) SFU; screen sharing up to 1080p;
direct messages with a friend system and opt-in requests from strangers; emoji reactions; voice
messages; a shared soundboard.

**Privacy** — voice and video are end-to-end encrypted, always, with a per-room SFrame key. Messaging
E2EE is opt-in per server or per DM: Signal Protocol (X3DH + Double Ratchet) for direct messages,
Sender Keys for channels, AES-256-GCM for files. Per-device identity keys with password-based
recovery.

**Organization** — multiple servers from one account, channels and categories, a granular role and
permission system with per-channel overrides, invites, join approval, public server discovery,
message pinning, and full-text search.

**Voice** — push-to-talk or voice activity detection, per-user volume, two noise-suppression engines
(RNNoise and a neural GTCRN mode), AFK auto-disconnect, and on Windows a native capture path that
encodes on the GPU so sharing a game does not cost you frames.

**Everywhere** — desktop apps for Windows, macOS and Linux with auto-update and differential
patching, iOS and Android apps with push notifications and native call handling, and the web.

**Details** — presence with idle detection, per-channel unread and mention badges, keyboard
shortcuts, context menus, custom themes and wallpapers, an in-app help centre, in-app feedback with
attachments, and English + Turkish throughout.

---

## How it works

```
                    mqvi.net (central)
                    ├── User accounts
                    ├── Friend lists
                    ├── Encrypted DMs
                    └── Server directory
                         /          \
              ┌─────────┘            └──────────┐
              ▼                                  ▼
    Public Hosting                        Self-Hosted Server
    (managed by mqvi)                     (your infrastructure)
    ├── Text & voice channels             ├── Text & voice channels
    ├── Messages & files                  ├── Messages & files
    └── Roles & permissions               └── Roles & permissions
```

One account on mqvi.net carries your identity, friends, DMs and memberships — nothing to set up to
start using mqvi. **Servers**, where channels and voice live, can be hosted by us or by you. Or run
the whole platform yourself and depend on nobody.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Go — `net/http` + `gorilla/websocket` |
| Database | SQLite (`modernc.org/sqlite`, pure Go) with FTS5 trigram search |
| Frontend | React + TypeScript + Vite, Zustand, hand-written CSS with theme tokens |
| Desktop | Electron |
| Mobile | Capacitor (iOS + Android) |
| Voice/Video | LiveKit, self-hosted, with SFrame E2EE |
| Messaging E2EE | Signal Protocol (X3DH + Double Ratchet), Sender Keys, `@noble/curves` |
| Auth | JWT access + refresh |

The server compiles to a **single static binary** with the frontend embedded — that is why the
one-command install needs no runtime.

---

## Development

```bash
git clone https://github.com/akinalpfdn/Mqvi.git && cd Mqvi

cd server && go run .          # backend
cd client && npm install && npm run dev   # frontend, separate terminal
npm run electron:dev           # desktop shell, from the repo root
```

You need Go 1.22+, Node 22+, and a LiveKit server for voice — `deploy/livekit-setup.sh` sets one up
locally in a few seconds.

**[ARCHITECTURE.md](ARCHITECTURE.md)** explains how the pieces fit together: the layering, the
WebSocket hub, how voice channels bind to LiveKit instances, the encryption model, and the testing
conventions. Deeper per-subsystem notes live in [`architecture/`](architecture/), and
[`DECISIONS.md`](DECISIONS.md) records why things are the way they are.

---

## Roadmap

**Shipped** — text channels, voice and video with always-on E2EE, screen sharing with native GPU
capture on Windows, roles and permissions, reactions, soundboard, voice messages, DMs and friends,
pinning, full-text search, invites and join approval, server discovery, presence and AFK handling,
themes and wallpapers, help centre, desktop apps with auto-update, **iOS and Android apps** with push
notifications and native call handling, multi-server architecture, one-command self-hosting,
end-to-end encryption for DMs, channels, files and voice with key backup and recovery, and
region-aware voice routing across multiple SFUs.

**Planned** — plugin and bot API, federation between servers.

---

## Contributing

Contributions are welcome. Please read the [Contributing Guide](CONTRIBUTING.md) before opening an
issue or a pull request, and [ARCHITECTURE.md](ARCHITECTURE.md) before your first change.

---

## License

[AGPL-3.0](LICENSE) — free to use, modify and self-host, including inside your organisation. If you
distribute a modified version or offer it to others over a network, you must publish your source
under the same licence. Commercial use outside those terms requires a
[separate licence](COMMERCIAL-LICENSE.md). Contribution terms are in [CLA.md](CLA.md).
