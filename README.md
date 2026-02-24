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
  <a href="#self-hosting">Self-Host</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

---

## Why mqvi?

Popular communication platforms are increasingly demanding government-issued IDs from their users. After multiple data breaches, trusting them with your passport or national ID is a risk most people shouldn't have to take.

**mqvi** is built on a simple principle: your conversations should belong to no one but you.

- No phone number, or government ID required
- Zero data collection
- Full source code is public — don't trust, verify
- Self-host on your own server for complete control

---

## Features

### Communication
- **Text Channels** — Real-time messaging with file/image sharing, typing indicators, and message editing
- **Voice & Video** — Low-latency voice and video powered by [LiveKit](https://livekit.io) SFU
- **Screen Sharing** — 1080p/30fps with VP9 codec and adaptive bitrate
- **Direct Messages** — Private one-on-one conversations
- **Emoji Reactions** — React to messages with emoji

### Organization
- **Channels & Categories** — Organize conversations into text and voice channels
- **Roles & Permissions** — Granular permission system with channel-level overrides
- **Invite System** — Control who joins your server with invite codes
- **Message Pinning** — Pin important messages to channels
- **Full-Text Search** — Search through message history (FTS5)

### Voice Features
- **Push-to-Talk & Voice Activity Detection**
- **Per-User Volume Control** — Adjust individual user volumes (0-200%)
- **Microphone Sensitivity** — Configurable VAD threshold
- **Noise Suppression** — Built-in via LiveKit
- **Join/Leave Sounds**

### User Experience
- **Presence System** — Online, idle, DND status with automatic idle detection
- **Unread Tracking** — Per-channel unread message counts with @mention badges
- **Keyboard Shortcuts** — Navigate without touching the mouse
- **Context Menus** — Right-click actions everywhere
- **Theme Support** — Multiple color themes
- **i18n** — English and Turkish, with infrastructure for more languages

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go (net/http + gorilla/websocket) |
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Desktop | Tauri v2 (planned) |
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

All users have a single account on **mqvi.net**. Your account, friends, DMs, and server memberships live centrally. No extra domain or setup needed to start using mqvi.(You can still fork the project and manage everything by your own.)

**Servers** (where channels and voice chat live) can be hosted in two ways:

### Public Hosting
Create a server directly from the app. We handle the infrastructure — no technical knowledge needed, no domain to buy, no VPS to manage.

### Bring Your Own Server
Run your own server for full control over your community's data. Set up the server backend on your own hardware, then register it with the mqvi network by entering the server IP and secret key in the app. You automatically become the server owner.

- Channels, messages, voice, and files stay on **your** server
- Users still log in with their mqvi account — no separate registration
- You control roles, permissions, and server settings

---

## Self-Hosting

### Requirements

- Linux server (Ubuntu 22.04+ recommended)
- 2 vCPU, 4 GB RAM minimum (Hetzner CX23 works great)
- A domain name (optional — IP address works fine)

### 1. Download

Grab the latest release from [GitHub Releases](https://github.com/akinalp/mqvi/releases):

```bash
# On your server
mkdir -p ~/mqvi && cd ~/mqvi

# Download the latest release
curl -fsSL https://github.com/akinalp/mqvi/releases/latest/download/mqvi-server -o mqvi-server
curl -fsSL https://github.com/akinalp/mqvi/releases/latest/download/start.sh -o start.sh
curl -fsSL https://github.com/akinalp/mqvi/releases/latest/download/livekit.yaml -o livekit.yaml
curl -fsSL https://github.com/akinalp/mqvi/releases/latest/download/.env.example -o .env

chmod +x mqvi-server start.sh
```

The `mqvi-server` binary (~38 MB) is a single executable with the frontend, database migrations, and i18n files all embedded. No Go, Node.js, or any other runtime needed.

### 2. Configure

```bash
nano .env   # Change JWT_SECRET and LIVEKIT_API_SECRET
```

Generate secrets with:
```bash
openssl rand -hex 32
```

Make sure `LIVEKIT_API_SECRET` in `.env` matches the `keys.devkey` value in `livekit.yaml`.

### 3. Start

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
| `50000-50200` | UDP | LiveKit RTC (voice/video) |

### Environment Variables

See [`.env.example`](.env.example) for all options. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `9090` | HTTP port |
| `JWT_SECRET` | — | **Required.** Random string for token signing |
| `LIVEKIT_URL` | `ws://localhost:7880` | LiveKit server URL (use `wss://` with Caddy) |
| `LIVEKIT_API_KEY` | `devkey` | LiveKit API key (must match livekit.yaml) |
| `LIVEKIT_API_SECRET` | — | **Required.** Must match livekit.yaml |
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
git clone https://github.com/akinalp/mqvi.git
cd mqvi

# Backend
cd server
go mod download
go run .

# Frontend (separate terminal)
cd client
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/ws` to `localhost:8080`.

### Building from Source

If you want to build the server binary yourself instead of downloading a release:

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

This produces a single `mqvi-server` binary (~38 MB) with the frontend, migrations, and i18n files all embedded.

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
│   └── pkg/i18n/         # Backend i18n + embedded locales
├── client/               # React frontend
│   └── src/
│       ├── api/          # API client functions
│       ├── stores/       # Zustand state management
│       ├── hooks/        # Custom React hooks
│       ├── components/   # UI components
│       ├── styles/       # Theme + globals
│       ├── i18n/         # Frontend translations
│       └── types/        # TypeScript types
├── deploy/               # Build & deploy scripts
│   ├── build.ps1         # Windows build script
│   ├── redeploy.example.ps1  # Windows one-click redeploy (template)
│   ├── redeploy.example.sh   # Linux/macOS one-click redeploy (template)
│   ├── start.sh          # Server startup script
│   ├── livekit.yaml      # LiveKit SFU config template
│   └── .env.example      # Environment config template
├── livekit.yaml          # LiveKit config (development)
├── .env.example          # Environment config (development)
└── src-tauri/            # Tauri desktop wrapper (planned)
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
- Direct messages
- Message pinning & search
- Invite system
- Presence & idle detection
- Keyboard shortcuts
- Multiple themes
- i18n (EN + TR)

### In Progress
- Desktop app (Tauri v2)
- Docker Compose deployment

### Planned
- End-to-end encryption (E2EE)
- Multi-server architecture
- Thread / reply messages
- Take control (remote control via screen share)
- Mobile apps (iOS & Android)
- Bot / webhook API

---

## Contributing

Contributions are welcome! Please open an issue to discuss what you'd like to change before submitting a PR.

---

## License

[MIT](LICENSE) — use it however you want.
