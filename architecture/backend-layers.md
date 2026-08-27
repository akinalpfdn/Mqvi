# Backend layering, wiring and error contract

Verified against `main` at 2026-08-27.

## Layers

```
handlers/     HTTP parse + response only. No business logic.
services/     All business rules. Never sees *http.Request.
repository/    Data access only. Raw SQL. No business logic.
models/       Structs + validation.
middleware/   Auth, permissions, rate limiting, logging.
ws/           Hub + event dispatch.
pkg/          Shared utilities, no domain knowledge.
```

Handlers never touch the database. Services never see `http.Request` — they take domain types and a
`context.Context`. Repositories contain no rules.

**The dependency arrow is enforced by a test, not by convention.**
`middleware/layering_test.go` parses the middleware package's imports with `go/parser` and fails if
`handlers` appears. Middleware imported `handlers` for years purely to reach three context-key
constants; those now live in `pkg/ctxkeys`. The test even guards itself — an empty parse fails
rather than passing vacuously. Scope is direct imports in that directory only; a transitive path or
a future subpackage would slip past.

## Dependency injection

Constructor injection everywhere. No package-level mutable state. Everything is wired in
`server/init_*.go`:

| File | Lines | Role |
|---|---|---|
| `init_repos.go` | 103 | repositories over the `*sql.DB` |
| `init_services.go` | 377 | services, in dependency order |
| `init_handlers.go` | 112 | handlers over services |
| `init_routes.go` | 425 | `mux.Handle` per route, with middleware chains |
| `init_callbacks.go` | 280 | hub callbacks → services |
| `main.go` | 749 | config, DB, migrations, seeding, background workers, shutdown |

**Wiring order is load-bearing** and `init_services.go` says so in comments. `channelPermService` is
built before `voiceService` because it is the latter's permission resolver; then
`SetVoiceEnforcer(voiceService)` is called *back* on `channelPermService`, `roleService` and
`memberService` to close the cycle without a circular dependency. Setter injection is used only for
these post-construction back-references and for `SetAppLogger` / `SetOnChannelEmpty`.

`voiceService` has ~12 consumers (channel, member, server, admin-user, admin-server, voice-message,
soundboard services, the metrics collector, and handlers). Changing its interface is a wide blast
radius — enumerate callers before touching it.

## Interface segregation

Interfaces are declared **on the consumer side**, narrow, and named for the behaviour. Examples
worth copying:

- `services/voice_service.go`: `ChannelGetter`, `LiveKitInstanceGetter`, `ChannelBindingStore`,
  `OnlineUserChecker`, `AFKTimeoutGetter`, `VoiceAppLogger` — each is the smallest slice that
  service actually needs, and several are satisfied by the same concrete repository.
- `handlers/voice.go`: `voiceHandlerService` is a five-method subset of `VoiceService` so tests can
  stub it without implementing the full surface.
- `handlers/livekit_webhook.go`: `WebhookKeyLoader` is one method.

`ChannelBindingStore` also shows the optional-dependency pattern: a `nil` store is valid and means
"memory only", which is correct behaviour with a single instance and is what the service tests run
with.

## Error contract

`pkg/errors.go` defines the domain sentinels. **Services return these; handlers map them.**

```
ErrNotFound  ErrUnauthorized  ErrForbidden  ErrAlreadyExists
ErrBadRequest  ErrConflict  ErrInternal  ErrQuotaExceeded
ErrDeviceNotFound  ErrPrekeyExhausted  ErrInvalidKey
```

Mapping lives in `pkg/response.go`:

| Sentinel | Status |
|---|---|
| `ErrNotFound` | 404 |
| `ErrUnauthorized` | 401 |
| `ErrForbidden` | 403 |
| `ErrAlreadyExists`, `ErrConflict` | 409 |
| `ErrBadRequest` | 400 |
| `ErrQuotaExceeded` | 413 |
| anything else | 500 |

**A 500 never leaks the underlying message** — `pkg.Error` substitutes a generic body for that
status. This was a fix (`fix(invite): make invite use atomic and stop leaking internals on 500`).

Errors are wrapped with `%w` at every boundary and matched with `errors.Is`, never by string.

### Coded errors

`pkg.WithCode(err, code)` attaches a stable machine code the **client translates**, for cases where
the reason cannot be derived client-side. `pkg.CodeOf(err)` reads it back. Current codes:
`upload_infected`, `upload_scan_unavailable`, `upload_too_large_scan`, `upload_too_large`,
`password_too_short`, `password_contains_identity`, `password_too_long`, `password_breached`,
`encryption_required`, `encryption_not_available`.

Password breach can only be judged server-side, and the E2EE pair exists so the client can say *why*
a send failed instead of showing a generic error.

### Server errors are English, always

`pkg.Error` returns the sentinel's `err.Error()` text as-is. There is no i18n layer in between and
no handler uses a localizer. `Accept-Language` is **not read** on API requests. The backend i18n
package (`pkg/i18n`) is used **only** for push notifications, keyed off the user's `language` column.
This is a known gap recorded in `CLAUDE.md`; do not describe server errors as localised.

## pkg/ inventory

`antivirus` (ClamAV + circuit breaker), `apns`, `authcookie`, `breaker`, `cache`, `crypto`
(AES-256-GCM + key derivation), `ctxkeys`, `email`, `fileacl`, `files`, `georegion`, `i18n`,
`password`, `promparse` (Prometheus text parsing for LiveKit metrics), `push`, `ratelimit`,
`signedurl`, plus `errors.go` and `response.go` at the root.

## Middleware

`auth.go`, `permission.go`, `platform_admin.go`, `server_membership.go`. Context keys are all in
`pkg/ctxkeys`: `User`, `ServerID`, `Permissions`, `ClientRegion`.

Every endpoint gets auth; every mutating endpoint gets a permission check; server-scoped endpoints
get membership. A cross-server IDOR sweep in July (`fix(auth): enforce server ownership on
server-scoped endpoints`, `fix(security): close cross-server IDOR…`) added tests specifically for
these gates — see `services/cross_server_ownership_test.go`.

## Repository conventions

Raw SQL, no ORM. One repository per entity, interface in `repository/`, SQLite implementation
alongside (`sqlite_*.go`, 103 files).

**Column lists are centralised per entity** since `refactor(repository): one column list per entity
instead of seventeen copies` (08-02) — but only for the entities that were refactored (users,
servers, roles, devices). Every other repository still repeats its `SELECT`/`Scan` pairs by hand.

**The miscount trap.** Four SELECT lists and four Scans in one file means a miscount compiles
perfectly and fails at runtime with `sql: expected N destination arguments in Scan, not M`. This has
shipped at least once — `GetByServerID` in `sqlite_livekit.go` had `region` added to the Scan but
not the SELECT, breaking **every voice join on an unbound channel**, and no test caught it. When
editing a SELECT list, count the columns mechanically against the Scan.

Transactions: services use a `WithTx()` wrapper. Some repository methods need `*sql.DB` directly and
type-assert for it (`MigrateServers`, `MigrateOneServer`) — that constraint is documented inline
where it appears.

## Testing conventions

- Unit tests use mocks from `testutil/mocks.go` (1016 lines) and never load a real server.
- Repository tests run against the **real schema** (`test: run repository tests against the real
  schema`, 07-21) via `testutil/dbtest`, not against a hand-written table definition.
- `database/migration_smoke_test.go` asserts `PRAGMA foreign_keys` is on — the DSN sets it
  (`?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)`), and without it
  every `ON DELETE CASCADE` would silently no-op.
- Test names describe behaviour: `Should_X_When_Y` or the sentence style used in the newer voice
  tests. Not `TestGetUser`.
- Mutation verification is the house standard for anything security- or correctness-critical: break
  the behaviour, confirm the named test fails, revert. A test that has never failed has proved
  nothing. Several rounds of this are recorded in `PHASE-140-GEO-05-done.md`.

## Build and check commands

Windows paths (from `CLAUDE.md`); on macOS use the tools on `PATH`:

```
& 'C:\Program Files\Go\bin\go.exe' build ./...
& 'C:\Program Files\Go\bin\go.exe' vet ./...
& 'C:\Program Files\Go\bin\go.exe' test -race ./services
```

Never run `gofmt`/`go fmt` across a package — format only the files you edited, by name.
