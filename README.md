<p align="center">
  <img src="icons/mqvi-icon-512x512.png" alt="mqvi" width="80" />
</p>

<h1 align="center">mqvi</h1>

<p align="center">
  Open-source communication platform with voice, video, and text.<br/>
  No identity verification. No data collection. Self-host ready.
</p>

<p align="center">
  <a href="https://mqvi.net">Website</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#self-host-voice-server-only">Self-Host</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <a href="README.tr.md">🇹🇷 Türkçe</a>
</p>

---

## Why mqvi?

Popular communication platforms are increasingly demanding government-issued IDs from their users. After multiple data breaches, trusting them with your passport or national ID is a risk most people shouldn't have to take.

**mqvi** is built on a simple principle: your conversations should belong to no one but you.

- No phone number or government ID required
- Zero data collection
- Full source code is public — don't trust, verify
- Self-host on your own server for complete control

---

## Features

### Communication
- **Text Channels** — Real-time messaging with file/image sharing, typing indicators, and message editing
- **Voice & Video** — Low-latency voice and video powered by [LiveKit](https://livekit.io) SFU
- **Screen Sharing** — 1080p/30fps with VP9 codec and adaptive bitrate
- **Direct Messages** — Private one-on-one conversations with friend system
- **Emoji Reactions** — React to messages with emoji

### Organization
- **Multi-Server** — Join and manage multiple servers from a single account (Discord-style)
- **Channels & Categories** — Organize conversations into text and voice channels
- **Roles & Permissions** — Granular permission system with channel-level overrides
- **Invite System** — Control who joins your server with invite codes
- **Message Pinning** — Pin important messages to channels
- **Full-Text Search** — Search through message history (FTS5)

### Voice Features
- **Push-to-Talk & Voice Activity Detection**
- **Per-User Volume Control** — Adjust individual user volumes (0–200%)
- **Microphone Sensitivity** — Configurable VAD threshold
- **Noise Suppression** — Built-in via LiveKit
- **Join/Leave Sounds**

### User Experience
- **Desktop App** — Native Electron app with auto-update
- **Presence System** — Online, idle, DND status with automatic idle detection
- **Unread Tracking** — Per-channel unread message counts with @mention badges
- **Keyboard Shortcuts** — Navigate without touching the mouse
- **Context Menus** — Right-click actions everywhere
- **Custom Themes** — Multiple color themes
- **i18n** — English and Turkish, with infrastructure for more languages

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go (net/http + gorilla/websocket) |
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Desktop | Electron |
| State | Zustand |
| Voice/Video | LiveKit (self-hosted SFU) |
| Database | SQLite (modernc.org/sqlite, pure Go) |
| Auth | JWT (access + refresh tokens) |

---

## How It Works

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

All users have a single account on **mqvi.net**. Your account, friends, DMs, and server memberships live centrally. No extra domain or setup needed to start using mqvi. (You can still fork the project and run everything independently — see [Full Server](#self-host-full-server) below.)

**Servers** (where channels and voice chat live) can be hosted in two ways:

### Public Hosting
Create a server directly from the app. We handle the infrastructure — no technical knowledge needed.

### Bring Your Own Server
Run your own voice/video server for full control. See [Self-Host: Voice Server Only](#self-host-voice-server-only) below.

---

## Self-Host: Voice Server Only

Use your mqvi.net account normally — create a server, add friends, chat. The only difference: voice and video traffic goes through **your own LiveKit server** instead of ours. Your conversations never touch our infrastructure.

### Linux

SSH into your server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh | sudo bash
```

The script automatically:
1. Downloads the LiveKit binary
2. Opens firewall ports (UFW / firewalld)
3. Generates secure API credentials
4. Creates `livekit.yaml` config
5. Starts LiveKit as a systemd service

**Requirements:** Any Linux server (Ubuntu 22.04+ / Debian 12+ recommended), 1 GB RAM, 1 CPU core. Providers like Hetzner, DigitalOcean, or Contabo offer this for $3–5/month.

### Windows

Open **PowerShell as Administrator** and run:

```powershell
irm https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1 | iex
```

The script automatically:
1. Downloads the LiveKit binary
2. Opens Windows Firewall ports
3. Attempts router port forwarding via UPnP
4. Generates secure API credentials
5. Creates `livekit.yaml` config
6. Starts LiveKit with auto-start on boot (Task Scheduler)

**Requirements:** Windows 10/11. If using your own PC, it needs to stay on and connected to the internet.

### After Setup

When the script finishes, you'll see 3 values:

| Value | Example |
|-------|---------|
| **URL** | `ws://203.0.113.10:7880` |
| **API Key** | `LiveKitKeyf3a1b2c4` |
| **API Secret** | `aBcDeFgHiJkLmNoPqRsTuVwXyZ012345` |

Go to mqvi, create a new server, select **"Self-Hosted"**, and enter these 3 values. That's it.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Voice doesn't connect | Ports are probably closed. Run `sudo ufw status` (Linux) or check Windows Firewall. Also check your cloud provider's web firewall. |
| I can connect but hear no audio | UDP ports 50000–60000 might be blocked. Make sure your provider allows UDP on these ports. |
| "Connection refused" error | LiveKit might not be running. Run `systemctl status livekit` (Linux) or check Task Manager for `livekit-server` (Windows). |
| Works on LAN but not from outside | Make sure `use_external_ip: true` is set in your `livekit.yaml`. On Windows, also check that your router forwards ports 7880, 7881, 7882, and 50000–60000. |

---

## Self-Host: Full Server

Run the entire mqvi platform on your own infrastructure. Completely independent from mqvi.net — you control everything: accounts, messages, files, voice.

### Requirements

- Linux server (Ubuntu 22.04+ recommended)
- 2 vCPU, 4 GB RAM minimum
- Domain name (optional — IP address works fine)

### Quick Start

```bash
mkdir -p ~/mqvi && cd ~/mqvi

# Download the latest release
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-server -o mqvi-server
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/start.sh -o start.sh
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/livekit.yaml -o livekit.yaml
curl -fsSL https://github.com/akinalpfdn/Mqvi/releases/latest/download/.env.example -o .env

chmod +x mqvi-server start.sh
```

The `mqvi-server` binary (~40 MB) is a single executable with the frontend, database migrations, and i18n files all embedded. No Go, Node.js, or any other runtime needed.

### Configure

Edit `.env` and set at least these 3 secrets:

```bash
nano .env
```

| Variable | How to generate |
|----------|----------------|
| `JWT_SECRET` | `openssl rand -hex 32` |
| `LIVEKIT_API_SECRET` | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` |

Make sure `LIVEKIT_API_SECRET` in `.env` matches the `keys.devkey` value in `livekit.yaml`.

### Start

```bash
./start.sh
```

`start.sh` automatically downloads the LiveKit binary if not present, creates data directories, and starts both LiveKit and mqvi. To run in the background:

```bash
nohup ./start.sh > output.log 2>&1 &
```

Open `http://YOUR_SERVER_IP:9090` in your browser. The first user to register becomes the server owner.

### SSL with Caddy (optional)

```bash
apt install caddy
```

Add to `/etc/caddy/Caddyfile`:

```
yourdomain.com {
    reverse_proxy localhost:9090
}

lk.yourdomain.com {
    reverse_proxy localhost:7880
}
```

```bash
systemctl restart caddy
```

Caddy automatically obtains and renews SSL certificates via Let's Encrypt. Update `LIVEKIT_URL` in `.env` to `wss://lk.yourdomain.com`.

### Firewall

Make sure these ports are open:

| Port | Protocol | Purpose |
|------|----------|---------|
| `9090` | TCP | Web UI + API |
| `7880` | TCP | LiveKit signaling |
| `7881` | TCP | LiveKit TURN relay |
| `7882` | UDP | LiveKit media |
| `50000–60000` | UDP | LiveKit ICE candidates |

### Environment Variables

See [`.env.example`](deploy/.env.example) for all options. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `9090` | HTTP port |
| `JWT_SECRET` | — | **Required.** Random string for token signing |
| `LIVEKIT_URL` | `ws://localhost:7880` | LiveKit server URL (use `wss://` with Caddy) |
| `LIVEKIT_API_KEY` | `devkey` | LiveKit API key (must match livekit.yaml) |
| `LIVEKIT_API_SECRET` | — | **Required.** Must match livekit.yaml |
| `ENCRYPTION_KEY` | — | **Required.** AES-256 key for encrypting stored credentials |
| `DATABASE_PATH` | `./data/mqvi.db` | SQLite database path |
| `UPLOAD_DIR` | `./data/uploads` | File upload directory |
| `UPLOAD_MAX_SIZE` | `26214400` | Max upload size in bytes (25 MB) |

---

## Development

### Prerequisites

- Go 1.21+
- Node.js 20+
- npm

### Setup

```bash
# Clone
git clone https://github.com/akinalpfdn/Mqvi.git
cd Mqvi

# Backend
cd server
go mod download
go run .

# Frontend (separate terminal)
cd client
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/ws` to `localhost:9090`.

### Building from Source

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File deploy\build.ps1
```

**Linux / macOS:**
```bash
# Frontend
cd client && npm install && npm run build && cd ..

# Copy frontend into server for embedding
rm -rf server/static/dist && cp -r client/dist server/static/dist

# Backend (single binary with embedded frontend)
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../deploy/package/mqvi-server .
cd ..
```

### Project Structure

```
mqvi/
├── server/               # Go backend
│   ├── main.go           # Entry point + wire-up
│   ├── config/           # Environment-based config
│   ├── models/           # Domain structs
│   ├── repository/       # Data access (raw SQL)
│   ├── services/         # Business logic
│   ├── handlers/         # HTTP/WS request handling
│   ├── middleware/        # Auth, permissions, rate limiting
│   ├── ws/               # WebSocket hub + events
│   ├── database/         # SQLite + embedded migrations
│   ├── static/           # Embedded frontend (populated at build)
│   └── pkg/              # Shared utilities
│       ├── i18n/         # Backend i18n + embedded locales
│       └── crypto/       # AES-256-GCM encryption
├── client/               # React frontend
│   └── src/
│       ├── api/          # API client functions
│       ├── stores/       # Zustand state management
│       ├── hooks/        # Custom React hooks
│       ├── components/   # UI components
│       ├── styles/       # Theme + globals
│       ├── i18n/         # Frontend translations (EN + TR)
│       └── types/        # TypeScript types
├── electron/             # Electron desktop wrapper
│   ├── main.ts           # Main process
│   └── preload.ts        # Preload script (secure IPC)
├── deploy/               # Build & deploy scripts
│   ├── build.ps1         # Windows build script
│   ├── start.sh          # Server startup script
│   ├── livekit-setup.sh  # LiveKit auto-setup (Linux)
│   ├── livekit-setup.ps1 # LiveKit auto-setup (Windows)
│   ├── livekit.yaml      # LiveKit config template
│   └── .env.example      # Environment config template
└── docker-compose.yml    # Docker development stack
```

### Architecture

```
handlers/ → services/ → repository/ → SQLite
    ↕            ↕
middleware    ws/hub (WebSocket broadcast)
```

- **Layered architecture**: handlers parse HTTP, services contain business logic, repositories handle data access
- **Constructor dependency injection**: no global state, all dependencies injected via constructors
- **Interface segregation**: consumers depend on minimal interfaces, not concrete types
- **WebSocket hub**: fan-out pattern for real-time event broadcasting

---

## Roadmap

### Shipped
- Text channels with real-time messaging
- Voice & video calls (LiveKit)
- Screen sharing (1080p/30fps)
- Role & permission system with channel overrides
- Emoji reactions
- Direct messages & friend system
- Message pinning & search
- Invite system
- Presence & idle detection
- Keyboard shortcuts
- Custom themes
- i18n (EN + TR)
- Desktop app (Electron with auto-update)
- Multi-server architecture
- One-click self-host setup (LiveKit)

### Planned
- End-to-end encryption (E2EE)
- Mobile apps (iOS & Android)
- Plugin / bot API
- Federation between servers
- Encrypted file sharing

---

## Contributing

Contributions are welcome! Please open an issue to discuss what you'd like to change before submitting a PR.

---

## License

[MIT](LICENSE) — use it however you want.
