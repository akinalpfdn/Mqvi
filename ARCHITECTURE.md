# Architecture

How mqvi is put together, for people who want to work on it. If you only want to run it, see the
[README](README.md).

mqvi is a self-hostable communication platform: text channels, DMs, voice and video, screen sharing,
with end-to-end encryption. A Go backend serves a React frontend, real-time state travels over one
WebSocket, and voice/video runs through a self-hosted [LiveKit](https://livekit.io) SFU. The same
frontend ships as a web app, an Electron desktop app, and a Capacitor mobile app.

## Stack

| Layer | Choice |
|---|---|
| Backend | Go, `net/http` + `gorilla/websocket` |
| Database | SQLite via `modernc.org/sqlite` (pure Go, no cgo) |
| Frontend | React + TypeScript + Vite, Zustand for state |
| Desktop | Electron 42 |
| Mobile | Capacitor 8 (iOS + Android) |
| Voice/Video | LiveKit SFU, self-hosted, SFrame E2EE |
| Messaging E2EE | X3DH + Double Ratchet (DMs), Sender Keys (channels) |
| Auth | JWT access + refresh |
| Deploy | systemd + Caddy, or Docker |

SQLite being pure Go is load-bearing: it lets the server cross-compile to a single static binary for
`linux/amd64` and `linux/arm64` with no toolchain, which is what makes the one-command install work.

## Repository layout

```
server/            Go backend
  main.go          entry point, wiring, background workers
  init_*.go        dependency wiring, split by concern
  config/          environment-based configuration
  models/          domain structs + validation
  repository/      data access, raw SQL, one file per entity
  services/        business logic
  handlers/        HTTP/WS request handling
  middleware/      auth, permissions, membership
  ws/              WebSocket hub + event dispatch
  database/        connection + embedded migrations
  pkg/             shared utilities (crypto, ratelimit, signedurl, i18n, …)
client/            React frontend
  src/api/         API client functions
  src/stores/      Zustand stores
  src/hooks/       custom hooks, including the WebSocket layer
  src/components/  UI
  src/crypto/      E2EE implementation
  src/i18n/        translations (EN + TR)
  ios/ android/    Capacitor native projects
electron/          Electron main + preload
native/            Windows native helpers (C++ and Rust)
architecture/      per-subsystem engineering notes
deploy/            install and deployment scripts
```

## Backend

### Layers

```
handlers/  →  services/  →  repository/  →  SQLite
    ↕             ↕
middleware      ws/ (hub)
```

Handlers parse requests and write responses; they never touch the database. Services hold every
business rule and never see an `*http.Request` — they take domain types and a `context.Context`.
Repositories are CRUD and queries only.

The dependency arrow is enforced by a test, not by convention:
`middleware/layering_test.go` parses the middleware package's imports and fails if `handlers`
appears.

### Dependency injection

Constructor injection everywhere, no package-level mutable state. Everything is wired in
`server/init_*.go` — repositories, then services in dependency order, then handlers, then routes,
then hub callbacks. Setter injection is used only for post-construction back-references that would
otherwise be circular.

Interfaces are declared **on the consumer side** and kept small. A service that needs one method from
a repository declares a one-method interface rather than depending on the whole thing.

### Errors

Services return sentinel errors from `pkg/errors.go` (`ErrNotFound`, `ErrForbidden`,
`ErrBadRequest`, …); handlers map them to HTTP status codes in `pkg/response.go`. A 500 never leaks
the underlying message. Errors are wrapped with `%w` and matched with `errors.Is`, never by string.

Where the client needs to explain a rejection it cannot derive itself — a breached password, a
message refused because the conversation mandates encryption — the error carries a stable machine
code via `pkg.WithCode`, and the client translates it.

Server error text is English. Backend i18n exists but is used only for push notifications, localised
from the user's stored language.

## Real-time

One WebSocket per connection, `server/ws/`. The hub is a fan-out registry — there is no persistence
and no replay buffer.

Each connection runs three goroutines: a read pump, a write pump, and a **single ordered worker**
that drains inbound events one at a time. The ordering matters: a voice join must be fully applied
before the state update that follows it.

Fan-out is indexed rather than linear — the hub keeps a serverID → connections map, so broadcasting
to a server is proportional to that server's size. Channel events are additionally filtered by the
recipient's `ViewChannel` and `ReadMessages` permissions, and presence goes only to people who share
a server, a friendship or a DM with the subject.

Three identities are distinguished and it matters:

- **user** — the account; one user has many connections
- **session** — one connection; anything that must act on exactly one device is tagged with it
- **device** — one installation; the unit push tokens register under

Recovery after a dropped socket is two steps rather than replay: the `ready` payload resyncs state,
then open tabs re-fetch their messages.

## Voice

Voice and video run through LiveKit. The server never carries media — it mints tokens, and issues
control operations (removing a participant, enforcing a server-mute) against the SFU's API.

A deployment can have **many LiveKit instances**. A voice channel is bound to exactly one of them:
the first person to join an empty channel claims an instance, and everyone after follows that
binding. The binding is persisted so a server restart cannot split a call in progress. For
platform-managed instances the choice is region-aware — the joiner's rough location comes from
Cloudflare's `CF-IPCountry` header, which the client cannot forge. Self-hosted servers always use
their own instance and are never relocated.

Two background sweeps decide when someone stops being in a call: one watches WebSocket presence, one
asks the SFU directly. They exist because neither signal alone is sufficient, and the reasoning is
worth reading before changing either — see `architecture/voice.md`.

Server-mute is enforced twice on purpose: live at the SFU by revoking the microphone publish source,
and baked into the next token so it survives a reconnect.

## End-to-end encryption

Three separate systems, deliberately:

- **DMs** — X3DH + Double Ratchet, per-device sessions
- **Channels** — Sender Keys: encrypt once, all members decrypt; rotated on member removal, every
  100 messages, or every 7 days
- **Voice** — SFrame with a per-room passphrase

Primitives are X25519, Ed25519, HKDF-SHA-256, HMAC-SHA-256 and AES-256-GCM, via `@noble/curves`
(Electron's Chrome build lacked Web Crypto X25519). Keys live in IndexedDB and never reach the
server.

The ratchet is a load-mutate-save cycle against IndexedDB, and inbound WebSocket events are routed
without awaiting, so two messages on one conversation can decrypt at once. A per-key lock
(`client/src/crypto/sessionLock.ts`) serialises that; without it one message silently discards the
other's ratchet advance.

The server enforces its own encryption policy rather than trusting the client's choice: a plaintext
message sent to a conversation with E2EE enabled is rejected. The client fails closed when it cannot
tell whether a conversation is encrypted, which means **operators must upgrade the server before
rolling out clients**.

## Files

Uploads go through one pipeline: MIME and path validation, per-user byte quota, ClamAV scanning, then
storage under a per-type directory. Files are served through signature-gated URLs signed at every
egress — stored URLs are kept unsigned, because a signature parked in long-lived state expires and
starts serving 401s.

Chat images store a companion thumbnail generated on the client, charged to the uploader's quota and
scanned like any other upload. Multipart uploads use XMLHttpRequest rather than `fetch`, because the
Fetch API has no upload-progress event and no working cancel.

## Data

SQLite in WAL mode with foreign keys on and a busy timeout. Migrations are sequential SQL files
embedded in the binary and applied at startup inside a transaction, with the filename recorded in the
same transaction so a partial migration cannot be marked done. Every migration must be idempotent.

Search uses FTS5 external-content tables. Accounts and servers use soft delete with a 30-day recovery
window, and a daily worker handles expiry, orphaned files and retryable deletes.

## Client

Zustand stores, sliced by domain — never one monolith. Components call hooks, hooks call stores,
stores call API services; nothing skips a layer. Server state lives in stores synchronised by
WebSocket events, with no additional caching layer on top.

All colours, fonts and repeated dimensions come from theme tokens in `client/src/styles/globals.css`.
Components do not carry inline colours or arbitrary pixel values.

Every user-visible string goes through `t()`, and English and Turkish are updated together.

## Desktop, mobile and native code

The Electron main process owns window lifecycle, the tray, auto-update, global shortcuts, and the
native helper processes. Because the E2EE worker and the microphone denoiser both run in the
renderer, the app explicitly disables Chromium's renderer backgrounding — otherwise a fullscreen game
that occludes the window degrades voice in both directions.

Capacitor wraps the same frontend for iOS and Android, with native plugins for CallKit/PushKit,
attachment picking and video poster extraction.

`native/` holds Windows-only helpers: WASAPI process-exclusive audio capture, a GPU probe used to
offer "share the game you're playing", and a Rust game-capture pipeline that does Windows Graphics
Capture into a Media Foundation hardware encoder and publishes the result to LiveKit directly.

## Testing

Unit tests use mocks and never load a server. Repository tests run against the real migrated schema,
not a hand-written one. WebSocket and voice concurrency is exercised with `-race`.

The house standard for anything security- or correctness-critical is **mutation verification**: break
the behaviour deliberately, confirm the named test fails, revert. A test that has never failed has
proved nothing. A green build proves it compiled; it does not prove it is right.

```bash
cd server && go test ./... && go vet ./...
cd server && go test -race ./services ./ws
cd client && npx tsc -b && npx vitest run
```

## Where the detail lives

- `architecture/` — per-subsystem engineering notes: the traps that are invisible from the code, the
  history behind decisions that look odd, and what each invariant is defending
- `CONTRIBUTING.md` — how to propose and submit changes
