# WebSocket

Verified against `main` at 2026-08-27. Line numbers drift — re-check anchors.

## Shape

`server/ws/` — `hub.go` (1157 lines), `client.go` (670), `event.go`, `handler.go`, plus seven test
files. The hub is a fan-out registry, not a message broker: there is no persistence and **no replay
buffer**.

**Three goroutines per connection**, all in `client.go`:

| Goroutine | Job |
|---|---|
| `ReadPump` | reads frames, handles heartbeat **inline**, enqueues everything else |
| `eventPump` | one worker per connection, drains the queue **in arrival order** |
| `WritePump` | serialises writes; `conn.WriteMessage` is additionally guarded by `client.mu` |

The ordered worker exists because a `voice_join` must be fully applied before the `voice_state_update`
that follows it. Handling events concurrently dropped voice state (`fix(ws): serialize per-connection
inbound events to prevent dropped voice state`, 07-08).

Heartbeat is handled on `ReadPump` rather than queued, because queueing it behind a wedged worker
would force a disconnect.

## Constants that matter

| Name | Value | Note |
|---|---|---|
| `writeWait` | 10s | |
| `pongWait` | **90s** | read deadline = 3 missed client heartbeats (30s × 3) |
| `maxMessageSize` | 32 KB | raised for WebRTC SDP + E2EE base64 overhead |
| `sendBufferSize` | 256 | outbound |
| `eventQueueSize` | 256 | a full queue means a wedged handler → drop the connection rather than block `ReadPump` |
| `eventBurst` / `eventRefillPerSec` | 20 / 10-per-sec | typing, presence, voice-state, calls |
| `signalBurst` / `signalRefillPerSec` | 100 / 50-per-sec | `p2p_signal` — trickle-ICE arrives in bursts |
| `MQVI_WS_MAX_CONNECTIONS_PER_USER` | default **10** | config refuses 0; an unwired hub gets 0 = unlimited |
| `MQVI_WS_CONNECTS_PER_MINUTE` | default **60** | handshake rate per account |

Client side (`client/src/utils/constants.ts`): `WS_HEARTBEAT_INTERVAL` 30 000 ms,
`WS_HEARTBEAT_MAX_MISS` 3, `WS_HEARTBEAT_PROBE_INTERVAL` 10 000 ms (a faster probe after a suspected
stall, which drops back to the normal interval on the first ack).

**Token refresh is every 10 minutes** (access token lives 15). Anything that breaks in under ~10
minutes is not a token problem — this has already been mis-diagnosed once.

## Identity: user vs session vs device

Three different ids, and confusing them causes real bugs:

- **userID** — the account. `hub.clients` is `map[userID]map[*Client]bool`, so one user has many
  connections (multi-tab, multi-device).
- **sessionID** — this *connection*. Sent to the client in the `ready` event, immutable. Anything
  that must act on exactly one device (accepting a call) is tagged with it.
- **deviceID** — this *installation*, and the same id the push token is registered under. It is what
  lets the server skip pushing to the device that already acted.

`GetOnlineUserIDs` returns a user if **any** connection is live. That is why the voice orphan sweep
cannot see a session abandoned while the user stays signed in elsewhere — see `voice.md`.

## Disconnect path — read before changing it

In `removeClient` (`hub.go`, around 380–430):

1. The presence **audience is captured before the delete**. Once the last connection is gone the
   user is no longer in `h.clients`, and an audience derived afterwards is empty — nobody would ever
   learn they went offline.
2. The client is removed from every `serverClients` index it belonged to.
3. If connections remain → `partialDisconnect`, recompute the aggregate status.
4. If none remain → `fullyDisconnected`, log `user fully disconnected (all tabs closed)`.
5. **`onSessionDisconnect` fires on every connection close, not just the last.** Its comment states
   the principle: *a call belongs to a CONNECTION*. P2P calls use this. Voice channels do not, and
   that asymmetry is the subject of the VP phase series.

Voice state is deliberately **not** torn down here — see the comment in `init_callbacks.go` and
commit `77be14e`.

## Broadcast scoping

Fan-out is indexed, not linear: `serverClients` maps serverID → connections, giving
`O(server_size)` instead of `O(total_clients)` for `BroadcastToServer`.

Public API: `BroadcastToAll`, `BroadcastToAllExcept`, `BroadcastToUser`, `BroadcastToUsers`,
`BroadcastToServer`, `BroadcastToServerExcept`.

Three scoping rules were each a security or performance fix:
- Channel broadcasts are filtered by `ViewChannel` + `ReadMessages` (`fc59771`, `717f51a`).
- Leave and voice broadcasts are scoped to server members (`31b8ff4`).
- Presence goes to `GetPresenceAudience` — people sharing a server, friends, DM partners — instead
  of every connected client (`perf(presence)`, 07-31). The entitlement is dropped when a
  relationship ends.

`invisibleUsers` tracks connected users whose status is "offline".

## Events

`event.go` defines **84 ops**. Routing is a registry — `var eventHandlers map[string]func(c *Client,
event Event)` populated in `init()` — not a switch. That was PHASE-001's refactor; adding an event
is one map entry.

Every outbound event carries a monotonic `seq` stamped by the hub (`seq atomic.Int64`).
**`seq` is currently consumed by nobody.** There is no replay: recovery is two steps — the `ready`
payload does a full state resync, then `resyncOpenTabs` re-fetches messages for open tabs. `seq`
exists so replay *could* be written later.

Inbound ops from the client are a small subset: `heartbeat`, `typing`, `presence_update`,
`voice_join`, `voice_leave`, `voice_state_update`, `voice_admin_state_update`, `voice_move_user`,
`voice_disconnect_user`, `screen_share_watch`, `voice_activity`, and the `p2p_*` signalling ops.

**`voice_join` has no authorization check.** No membership, no `PermConnectVoice`, no channel-type
check — those live in `GenerateToken`. Pre-existing and true on `main`.

## Client side

`client/src/hooks/useWebSocket.ts` owns the socket. Behaviours worth knowing:

- **Heartbeat with probe escalation.** On a suspected stall it switches to the 10s probe interval and
  restores the 30s one on the first ack. `WS_HEARTBEAT_MAX_MISS` closes the socket — the single
  close path.
- **`APP_RESUME_EVENT`** (`mqvi:app-resume`, dispatched from `utils/nativePlugins.ts` on Capacitor
  `appStateChange`) triggers either a reconnect or a liveness probe. The `online` event does the
  same but is rate-floored, because the OS fires it on every flap.
- **`voice_states_sync` handling** (`hooks/ws/voiceEventHandlers.ts`) has two recovery paths: a
  **re-assert** that sends `voice_join` over the WS *without requesting a token* when the server
  disagrees, and an **F5 recovery** that re-acquires a token. The re-assert path is why a channel can
  end up with participants but no instance binding after a restart.
- **Tab-scoped recovery guard** (`stores/shared/voiceRecovery.ts`): `sessionStorage` holds the
  channel a tab joined, so only the *same* tab auto-recovers after a reload. A fresh tab must never
  claim voice just because the backend still remembers the user.

## Tests

`ws/` has seven test files, and the interesting ones pin concurrency rather than routing:
`client_ordering_test.go` (the ordered worker), `client_race_test.go`, `client_ratelimit_test.go`,
`connection_limits_test.go`, `presence_audience_test.go`, `ready_payload_test.go`,
`shutdown_test.go`, `hub_test.go`.

`test(ws): stop racing the broadcast against its own unregister` and
`test(ws): pin the first-connect and last-disconnect callback edges` (08-10) exist because those
edges were genuinely racy. Run `go test -race ./ws` for anything here.

## Traps

- **Ghost pointer on reconnect.** A stale `Client` struct left in the hub map received an event after
  the user had reconnected and disconnected the live session. This is why `handleVoiceJoin` does
  *not* broadcast a `voice_replaced` event — the SFU's `DUPLICATE_IDENTITY` disconnect already
  signals handover, and the client handles it in `VoiceProvider.handleDisconnected`.
- **Send on closed channel.** Fixed at `fix(ws): prevent send-on-closed-channel panic on client
  teardown` (07-02); `client.markClosed()` and the write mutex are what keep it closed.
- **A refused WebSocket must look like any other outage to the client** — see the 2026-08-03 entry in
  `DECISIONS.md`. Do not add a distinct refusal signal the client branches on.
