# Voice

Verified against `main` at 2026-08-27 (after the GEO series and `5d553e1`). Line numbers drift —
re-check anchors before relying on them.

## Files and what owns what

All of these share **one** `voiceService` struct and **one** `sync.RWMutex`, deliberately, so the
concerns can cross-read each other without lock-ordering risk.

| File | Owns |
|---|---|
| `services/voice_service.go` | The struct, the ISP interfaces, `NewVoiceService`, the `VoiceService` interface |
| `services/voice_state.go` | `JoinChannel` / `LeaveChannel` / `UpdateState`, the `states` map, channel timers |
| `services/voice_token.go` | `GenerateToken`, `GenerateScreenShareToken`, client-failure log helpers |
| `services/voice_instance.go` | Which LiveKit instance a channel's room lives on. Claim, release, persist, region pick |
| `services/voice_lifecycle.go` | The two background sweeps, the AFK sweep, all server→SFU calls |
| `services/voice_admin.go` | Server mute/deafen, `MoveUser`, `AdminDisconnectUser`, SFU mute enforcement |
| `services/voice_e2ee.go` | Per-room SFrame passphrase; also the emptiness check that releases the binding |
| `services/voice_permission_enforce.go` | Re-applying permissions mid-call (fire-and-forget) |
| `services/voice_screenshare.go` | Screen-share viewer tracking |

## Lock discipline — the hard rule

**`s.mu` must never be held across DB or network I/O.** Everything that touches the database or the
SFU takes a snapshot under the lock, releases it, does the I/O, then re-acquires and re-verifies.

`sweepLiveKitReconciliation` is the canonical three-phase shape: snapshot under `RLock` → query
LiveKit with no lock → re-verify and mutate under `Lock`. Copy it rather than inventing another.

Functions whose names end in `Locked` **must** be called with the write lock held. Functions
documented `MUST NOT be called under mu.Lock` do I/O.

**Known pre-existing violation:** `AdminDisconnectUser` (`voice_admin.go`, around line 376) resolves
permissions — a DB call — while holding the write lock. Its siblings `AdminUpdateState` and
`MoveUser` deliberately do not, and say why in comments. This predates the GEO work; on `main` too.

## Voice state lifecycle

`s.states` is `map[userID]*models.VoiceState`. There is **one entry per user**, not per connection
or device — `models.VoiceState` has no session or device field. That matters: see "Known reachable
states" below.

**Every write site** (`s.states[...] = ` or `delete`):

| Site | What |
|---|---|
| `voice_state.go:98` | `JoinChannel` inserts |
| `voice_state.go:69` | `JoinChannel` deletes the old entry on a channel switch |
| `voice_state.go:160` | `LeaveChannel` |
| `voice_lifecycle.go:129` | orphan sweep reap |
| `voice_lifecycle.go:515` | LiveKit reconciliation reap |
| `voice_admin.go:400` | `AdminDisconnectUser` |

`JoinChannel` is reached **only** from the WebSocket `voice_join` op
(`ws/client.go` `handleVoiceJoin` → `init_callbacks.go:134`). It performs **no permission check and
no channel-type check** — those live in `GenerateToken`. This is pre-existing and true on `main`.

**Same-channel rejoin is silent** (`voice_state.go:55`): a WS reconnect that re-asserts the same
channel refreshes the profile and resets the LiveKit absence tracker, broadcasts nothing, and
returns early. This is what stops false leave/join sounds on every reconnect.

## The three sweeps

| Sweep | Interval | Grace | Source of truth | Started by |
|---|---|---|---|---|
| Orphan | 5s | `orphanGracePeriod` = **35s** | WS presence (`GetOnlineUserIDs`) | `StartOrphanCleanup` |
| LiveKit reconciliation | `livekitReconcileInterval` = **60s** | `livekitAbsentGrace` = **90s** | The SFU's participant list | `StartLiveKitReconciliation` |
| AFK | 30s | per-server `afk_timeout_minutes`, default **60**, `0` disables | `state.LastActivity` | `StartAFKChecker` |

**Orphan sweep** (`sweepOrphanStates`): two-phase per-user tracking in `s.offlineSince`. First
sighting offline only starts the clock; coming back online clears it; only after the full grace is
the state removed. On reap it broadcasts leave, stops the channel timer if the channel emptied,
releases the binding, and then — outside the lock — calls `removeParticipantFromLiveKit`, which
**actively evicts the user from the SFU**. It does not merely forget them.

`GetOnlineUserIDs` (`ws/hub.go:601`) returns a user if they have **any** live connection. So the
orphan sweep structurally cannot reap someone who is signed in on a second tab or device. That blind
spot is exactly why the reconciliation sweep exists.

**Reconciliation sweep** (`sweepLiveKitReconciliation`): asks the SFU who is actually in each
occupied channel. Skips a channel entirely on query error — a transient failure must never read as
"nobody is there". Screen-share identities (`{userID}_ss`) are normalised with `TrimSuffix` so a
user publishing a share still counts as present. `"room not found"` from LiveKit is treated as a
**confirmed empty room**, not an error, because that is the SFU closing a room nobody is in.

**AFK sweep**: three-phase, skips users who are streaming, groups DB lookups per channel, kicks via
`DisconnectUser` → `LeaveChannel`.

## LiveKit instance binding (the GEO series)

A voice channel's room lives on exactly one LiveKit instance. **The channel owns the binding, not
the server.** The first request for an empty channel claims one; everyone after follows it.

Why it must be one place: the room name is `serverID:channelID` (`generateRoomName`,
`voice_instance.go`) and carries **no instance identity**. Two paths resolving different instances
would each open a same-named room on a different SFU. Both halves work, neither hears the other,
and nothing errors.

### The two resolvers — do not confuse them

- **`resolveRoomInstance(ctx, serverID, channelID)`** — *claims* if unbound. Only two callers, both
  joins: `GenerateToken`, and nothing else since the screen-share path was changed.
- **`boundRoomInstance(ctx, channelID)`** — *follows* an existing binding, never claims. Returns
  `errChannelNotBound` when there is none. Everything server-side uses this:
  `removeParticipantFromLiveKit`, `listLiveKitParticipants`, `enforceServerMicMuteAtSFU`, and
  `GenerateScreenShareToken`.

Routing teardown through the claiming resolver was a real shipped bug: teardown runs immediately
after the binding is released, so it re-claimed the channel it had just freed and then addressed the
wrong machine. Recorded in `PHASE-140-GEO-05-done.md`.

### `errChannelNotBound` is not an error condition

No binding means **no room exists**, because a room only comes into being when a token is minted and
the channel claims an instance. Callers must treat it as "empty / nothing to do", not as failure:

- `listLiveKitParticipants` returns an empty set → phantoms in that channel still get reaped
- `removeParticipantFromLiveKit` returns silently → nothing to remove
- `enforceServerMicMuteAtSFU` returns silently → the mute is carried by the token bake instead
- `GenerateScreenShareToken` refuses with reason `channel_not_bound`

Failing instead meant the reconciliation sweep skipped the channel forever, which is the
stale-timer bug that sweep was written to fix.

### Claim, release, persistence

- **Claim** is guarded twice: a fast path that follows an existing binding, and a second check under
  the lock after the DB pick. Both are needed and both have a test — tokens are minted from an HTTP
  handler while `JoinChannel` arrives later over the WS, so two simultaneous joiners cannot see each
  other in `s.states`.
- **Decrypt before claiming.** Credentials that fail to decrypt must not leave a channel bound to
  something unusable, because the recovery path only rebinds when the instance is *missing*.
- **Release** happens in `cleanupRoomPassphraseIfEmpty` (in `voice_e2ee.go`), which is the shared
  emptiness check for the passphrase and the binding — deliberately the same lifetime. It returns
  the instance it released, and every teardown caller passes it to `removeParticipantFromLiveKit`,
  because after the release nothing else knows where the room was.
- **Persistence** is `channel_voice_bindings` (migration 090). Best-effort: a failed write leaves
  runtime correct and only degrades restart recovery. Table invariant: **empty except for calls in
  progress**. `claimed_at` is written and never read.
- **Rebind** only on `pkg.ErrNotFound` from the instance lookup. A transient DB error must **not**
  rebind — releasing a live call's binding is how the next joiner lands in a same-named room
  elsewhere.
- **Stale clears are guarded twice**: the async clear checks whether the channel has been re-claimed,
  and the delete is conditional on the instance id (`ClearChannelBinding(channelID, instanceID)`).

### `pendingJoins` — the token/join gap

The binding is claimed when the **token** is minted; everything that ends its life keys off
`s.states`, which only exists once the **WS join** arrives. `pendingJoins` (channelID → userID →
deadline, TTL `pendingJoinTTL` = 1 minute) closes that gap. It is counted by the emptiness check and
by `sweepAbandonedBindingsLocked`.

**Ordering is load-bearing:** `markPendingJoin` runs **before** `resolveRoomInstance` in
`GenerateToken`. It used to run after, and the abandoned-binding sweep (every 5s) could land in the
window between the claim and the marker and release a binding whose token had already gone out.

`sweepAbandonedBindingsLocked` runs at the end of every orphan sweep and releases bindings for
channels with neither participants nor pending joins — a token nobody ever used has no one to leave.

### Region selection

`pickInstance` short-circuits twice before region is even considered:
1. `!IsPlatformManaged` → a self-hosted server owns its LiveKit and is never relocated.
2. `region == models.RegionUnknown` (`""`) → the server's own instance, i.e. pre-region behaviour.

The signal is Cloudflare's `CF-IPCountry`, read in `handlers/voice.go` `Token` only, put on the
context as `ctxkeys.ClientRegion`. It is edge-set and not client-forgeable — which matters because
the first joiner places the call for everyone. `pkg/georegion` maps country → region with a
deliberately short table; unlisted countries fall to `eu-central`, and `""`/`XX`/`T1` yield unknown.

`GetPlatformInstanceForRegion` **orders, never filters** — placement can never be the reason someone
cannot talk. Because it can therefore return an instance from another region, `pickInstance` checks
`best.Region != region` and falls back to the server's own instance. Without that check, right after
migration 091 every instance reads as unknown, the region term is 0 for all of them, and the
ordering collapses to plain least-loaded — sending a German caller to a fresh Ashburn box.

Two different questions, two repository methods, and this distinction is load-bearing:
- `GetLeastLoadedPlatformInstance` — "may I register another server here?" **Hard** `max_servers`
  filter. Unit is right, running out is a real answer.
- `GetPlatformInstanceForRegion` — "where should this call go?" No filter at all.

**Trap:** `main.go:410` uses `GetLeastLoadedPlatformInstance` as an *existence* check when seeding
the platform instance. Because that query has a hard capacity filter, it returns `ErrNotFound` when
all instances are **full**, not only when none exist — so an operator who sets `max_servers` and
reaches it gets a duplicate instance seeded on every restart. Pre-existing; `main` has the same
filter. Not yet fixed.

**Trap:** `live_server_count` (registered servers) no longer says anything about voice load, since
placement became per channel and by region. An instance can carry live calls with zero servers on
it — the normal state of a freshly added region, and the state that makes it the *most* attractive
target. `DeleteInstance` now guards on `CountChannelBindings` for this reason. There is still **no
drain mechanism**: migrating servers off an instance lowers its count and makes it *more* preferred.

## Room naming

`generateRoomName(serverID, channelID)` → `"serverID:channelID"`. One place, pinned by
`voice_instance_test.go` including the exact wire format — changing it orphans every live room.

## E2EE passphrase

Per-room SFrame passphrase, 32 bytes from `crypto/rand`, base64url, **in memory only**
(`roomPassphrases`, keyed by room name). Deleted when the room empties, for forward secrecy — the
same emptiness check that releases the binding. Both tokens (`GenerateToken` and
`GenerateScreenShareToken`) return it; the client refuses a token without one.

**Server-side recording is incompatible with this.** Anything that must read the media — Egress,
transcription — cannot decrypt SFrame. That is an architectural fork, not a detail.

## Server mute

Enforced in two places that must stay in lockstep:
- **Live at the SFU** — `enforceServerMicMuteAtSFU` sets participant permissions. Revoking the
  microphone *source* unpublishes a live mic track and blocks republishing, so a non-cooperating
  client cannot bypass it. Bounded retry (3 attempts, 250ms); `not_found` is not retried.
- **Baked into the token** — `GenerateToken` applies the same allow-list when the user is currently
  server-muted, so the mute survives reconnect and admin-move. A fresh token would otherwise
  re-grant mic publish.

The shared allow-list is `serverMuteAllowedSources()`: camera, screen share, screen-share audio —
everything except the microphone. Mute is audio-only, Discord-style. Server **deafen** is
client-side only and not SFU-enforced.

Before enforcing, `AdminUpdateState` re-resolves the target's permissions **fresh** (not cached),
because a role change that just revoked Speak may not have invalidated the cache and re-asserting
publish off a stale value would clobber live permission enforcement.

## Known reachable states worth remembering

**Occupied but unbound.** A channel can have participants in `s.states` with no instance binding:
`MoveUser` rewrites `state.ChannelID` and hands out a force-move grant without claiming the target,
and the WS `voice_join` path never claims at all. Handled by `errChannelNotBound` treating it as an
empty room.

**Binding row leaks after a restart.** After a restart the binding lives only in the DB; clients
re-assert over the WS without asking for a new token, so nothing adopts it into memory. The last
leaver then found nothing in memory and never cleared the row. Fixed by `clearStoredBindingIfAny`,
which reads before deleting so a row written by a newer session survives.

**The iOS background drop — open.** iOS freezes the WKWebView content process; the WS closes
immediately; 35s later the orphan sweep removes the state *and evicts the user from the SFU*, while
`UIBackgroundModes: audio, voip` mean the media session was still alive. Confirmed from production
`app_logs` on 2026-08-18 by the `PARTICIPANT_REMOVED` disconnect reason (an actual eviction), versus
`already left LiveKit` for genuinely-departed users. Planned work: `PHASE-142-VP-01` …
`PHASE-146-VP-05`.

**LiveKit webhooks arrive and are discarded.** `handlers/livekit_webhook.go` receives
`participant_joined` / `participant_left` with `disconnect_reason`, HMAC-verified against every
instance's key, and only writes to `app_logs`. It has no reference to `voiceService`. This is the
authoritative signal the sweeps are polling for.

**`disconnect_reason` is a trap.** At least `DUPLICATE_IDENTITY` (a newer session superseded the
old one — appears during ordinary reconnects), `MIGRATION` (LiveKit moving between its own nodes)
and `PARTICIPANT_REMOVED` (our own teardown returning to us) must **not** cause a removal.

## Tests

`services/voice_sweep_guard_test.go` — **12** tests pinning the two sweeps. Its header names the
three production incidents that shaped them: users kicked for no reason (`0002f50`), users broken by
a second device, and phantoms (`5e8a367`). Until this file none of the three had a test.

`TestOrphanSweep_*`: FirstSightingOnlyStartsTheClock, KeepsAUserInsideTheGracePeriod,
ReapsOnceTheGraceExpires, ReturningOnlineClearsTheClock, NeverTouchesAUserOnlineOnAnotherDevice.

`TestReconcile_*`: SkipsTheChannelWhenLiveKitIsUnreachable, AbsenceIsOnlyTrackedOnFirstSighting,
KeepsAnAbsentUserInsideTheGrace, ReapsThePhantomOnceTheGraceExpires, PresenceClearsTheAbsenceClock,
ScreenShareIdentityCountsAsPresent, RoomNotFoundIsAConfirmedEmptyRoom.

**How the LiveKit fake works** — reusable technique: an `httptest.Server` answering
`/twirp/livekit.RoomService/ListParticipants` with a `proto.Marshal`ed `ListParticipantsResponse`
and `Content-Type: application/protobuf`, with the mock instance's URL pointed at it. A second
variant returns an arbitrary status/body for the error paths, and a third accepts the connection and
never responds, for the unreachable case.

`services/voice_instance_binding_test.go` — ~40 tests over claim/release/persist/region/pending-join.
Uses a getter that hands out a **different instance every time it is asked to pick**, so "everyone
ended up in the same room" is a falsifiable claim. Its harness goes through the real
`NewVoiceService` constructor on purpose: a hand-built struct literal silently missed every field
added later and went nil on `pendingJoins` the moment that map was introduced.

Other files: `voice_service_test.go` (join/leave/state, plus the Phase-44 guard that teardown must
survive the channel row being deleted), `voice_timer_test.go` (channel timers, absence-tracker
resets), `voice_mute_test.go`, `voice_permission_enforce_test.go`, `voice_teardown_test.go`,
`voice_screenshare_log_test.go`, `voice_instance_test.go` (room-name format).

Always run `go test -race ./services` for changes here — it takes ~50s and the concurrency is real.
