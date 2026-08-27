# architecture/ — agent knowledge base

**This is not contributor documentation.** It is the working memory of whoever (usually Claude) is
editing this codebase, kept outside the context window so it does not have to be re-derived every
session. It is deliberately more detailed than a contributor would ever want, and it is written for
retrieval, not for reading front to back.

Contributor-facing docs are a separate, shorter artifact. `README.md` is a third thing again.

## How to use this

1. Always read this INDEX. It is small on purpose.
2. Open only the subsystem file you need. Do not load the whole folder.
3. Treat every claim here as **verified at the commit it was written against**. If a claim names a
   file, symbol or line, re-check it before relying on it — line numbers drift.
4. When a claim turns out to be wrong, fix it here in the same change. A stale entry is worse than
   a missing one.

## Maintenance rule — this is why it exists

The failure mode this folder replaces: knowledge that lived only in `~/.claude/.../memory/` went
stale because updating it was a separate act that got skipped.

**A phase does not close until this folder reflects it.** Same bar as `DECISIONS.md`. If a change
alters an invariant, a lifecycle, a lock discipline or a trap recorded here, updating the relevant
file is part of the work, not follow-up.

## Map

| File | Covers |
|---|---|
| `backend-layers.md` | Go layering, DI and wiring order, ISP conventions, error contract, repository rules, test conventions |
| `websocket.md` | Hub, per-connection goroutines, user/session/device identity, disconnect path, broadcast scoping, ops, client reconnect |
| `voice.md` | Voice state lifecycle, the three sweeps, LiveKit instance binding, region routing, server mute, E2EE passphrase, guard tests |
| `auth-and-permissions.md` | JWT audiences and `tv` revocation, passwords, the permission bitfield, effective-permission cache vs fresh, rate limiting, file access |
| `database.md` | SQLite pragmas and pool, the migration runner, FTS5, repository conventions, the miscount and alias-shadowing traps, soft delete |
| `files-and-uploads.md` | Upload pipeline, quota accounting, ClamAV + circuit breaker, thumbnails, the XHR transport split, cleanup |
| `e2ee.md` | The three separate systems, sender keys, the ratchet session lock, devices and key backup, server-side policy, upgrade order |
| `client-state.md` | Zustand stores and slices, mutations-through-stores, WS handlers and resync, caching decisions, mobile constraints, styling rules |
| `packaging-and-release.md` | Electron/Capacitor shells, electron-builder rules, auto-update and blockmaps, CI release, native components, renderer priority |
| `deploy-and-selfhost.md` | The two self-host modes, what `install.sh` does, the seeding chain, config, health, zero-downtime deploy, bandwidth budget |

## Project shape

Started **2026-02-11**. 767 commits on `main` as of 2026-08-27, 41 merged PRs.

| Area | Size |
|---|---|
| Go backend (`server/`) | 372 `.go` files — repository 103, services 95, models 48, handlers 47, pkg 42, ws 12 |
| React client (`client/src/`) | 228 `.ts` + 185 `.tsx` — components 182, stores 56, hooks 49, utils 39, api 36, crypto 18 |
| Migrations | 92 SQL files, sequential, `schema_migrations` tracks applied filenames |
| Native | Rust (`native/game-capture`), Swift (iOS plugins), C++/MF (Windows encode) |

Largest files, useful as "where the mass is": `repository/sqlite_user.go` (1159), `ws/hub.go` (1157),
`services/server_service.go` (1020), `repository/sqlite_dm.go` (1003), `services/p2p_call_service.go`
(861), `client/components/voice/VoiceStateManager.tsx` (1021), `client/stores/p2pCallStore.ts` (966).

## History arc — what shape the codebase is in and why

- **Feb 2026** — extremely fast greenfield. Multiple features per day, terse commit subjects.
  Tauri → **Electron** migration on 02-25. WASAPI process-exclusive audio capture 02-26.
  Multi-server migration 02-28.
- **Mar 2026** — multi-LiveKit support, rate limiting, admin panel, metrics. **E2EE lands 03-04**
  (device foundation → crypto layer → DM → channel → file → voice) and is hardened through 03-07.
  03-08: the whole codebase's Turkish comments were translated to English in one sweep — this is why
  the comment style is uniform and why rule 16 in `CLAUDE.md` exists.
- **Apr–May 2026** — files and uploads become a real subsystem: per-type dirs, path validation,
  signed URLs, per-user quota, ClamAV, soft-delete with a daily cleanup worker, JWT hardening
  (aud-separated tokens, `tv` revocation).
- **Jun 2026** — P2P calls get TURN relay and ICE restart. Help center. Soundboard. Voice messages.
  Mobile push (FCM) begins; Android and iOS native call wake (full-screen intent / CallKit).
- **Jul 2026** — the busiest month. Security hardening (IDOR sweeps), join approval, server
  discovery, multi-device notification correctness, **native game capture** (Rust + Media
  Foundation + WGC), upload overhaul with thumbnails, test-coverage push, zero-downtime deploy.
- **Aug 2026** — WS connection limits, hub/crypto tests, a client refactor routing mutations through
  stores, GTCRN noise suppression, and the geo-aware voice routing work (GEO series).

The arc that matters: this started as a fast prototype and has been progressively hardened. Old code
tends to be terser and less defended; code touched after ~June carries long "why" comments recording
a specific failure. Both styles are intentional — see the 2026-08-19 entry in `DECISIONS.md`.

## Cross-cutting facts

**Phases and decisions.** `.claude/phases/` holds 146 phase files (`PHASE-XXX-CODE-YY-status.md`).
They were *not* kept from the start — early ones are thin and there are gaps, which is why commit
history is the better source for anything before ~June. `DECISIONS.md` has 28 entries and is
append-only.

**Both `CLAUDE.md` and `DECISIONS.md` are gitignored**, as is `docs/` and `.claude/`. A fresh clone
has none of them. This folder is tracked precisely so it survives a clone.

**Known-wrong statement in `CLAUDE.md`:** it says the server binary is not published to releases.
It is — CI builds `mqvi-server-linux-{amd64,arm64}` (`.github/workflows/build-desktop.yml:226-231`)
and `deploy/install.sh` downloads it from `releases/latest/download/`. Verified against release
v2.24.0. Do not act on that line.

**Line endings are mixed.** Git stores LF; checkout produces CRLF for many files but not all
(`electron/main.ts` is LF in the working tree, `client/.../AppLayout.tsx` is CRLF). Any script that
matches multi-line text must normalise first, or anchors silently stop matching. Never run
`gofmt`/`go fmt` across a package — format only the files you edited, by name.

**Verification honesty.** A green build proves it compiled. A green suite proves the tests that
exist passed. This project has repeatedly shipped bugs that compiled, vetted and passed everything —
see the audit passes recorded in `PHASE-140-GEO-05-done.md`. When claiming a fix works, name the
test that would fail if it did not.
