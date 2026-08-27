# Auth, permissions and file access

Verified against `main` at 2026-08-27.

## Tokens

JWT, signed with `JWT_SECRET`. Two audiences, and the separation is deliberate:

| Audience | Constant | TTL |
|---|---|---|
| API | `models.AudienceAPI` | `JWT_ACCESS_EXPIRY_MINUTES` (15 by default) |
| File | `models.AudienceFile` | the **refresh** expiry (`JWT_REFRESH_EXPIRY_DAYS`, 7) |

`validateToken` rejects a token with no audience and a token whose audience does not match what the
caller asked for. A file token therefore cannot be replayed against the API, which is the point — the
file token is long-lived because in-app rendering needs it to outlive a signed URL, and that would
be unacceptable for API access.

Recorded in `DECISIONS.md`, 2026-05-10 — "Purpose-Bound File Tokens and JWT Revocation".

**Revocation is `TokenVersion` (`tv`).** Every signed token carries the user's current `tv`;
bumping the column invalidates every outstanding token for that account at once. Used on password
change and forced logout. There is no denylist.

Client refresh interval is **10 minutes** against a 15-minute access token (`useWebSocket.ts`).
Anything failing in under ~10 minutes is not a token problem.

Related hardening from the same sweep: atomic password rotation, reset-sibling cleanup, and
`fix(auth): keep tokens on transient failures and force-logout on refresh rejection` — a network
blip must not log people out, but a *rejected* refresh must.

## Passwords

bcrypt, cost 12. `pkg/password` additionally rejects, at **every entry point** (register, change,
reset):

- too short / too long
- contains identity (username, email)
- **breached** — checked against a breach corpus, gated by `MQVI_PASSWORD_BREACH_CHECK`

These come back as coded errors (`password_too_short`, `password_contains_identity`,
`password_too_long`, `password_breached`) because only the server can judge a breach, and the client
translates the code.

Login returns identical errors for "no such user" and "wrong password".

## Permissions

`models.Permission` is an `int64` **bitfield** (`models/role.go`), 19 bits:

```
ManageChannels ManageRoles KickMembers BanMembers ManageMessages SendMessages
ConnectVoice Speak Stream Admin ManageInvites ReadMessages ViewChannel
MoveMembers MuteMembers DeafenMembers UseSoundboard ManageSoundboard ApproveMembers
```

`PermAll = (1 << 19) - 1` — **update the shift when adding a permission**, it is not derived.

`Permission.Has()` **short-circuits on `PermAdmin`**: an admin passes every check. Anything that must
apply to admins too cannot use `Has`.

Ownership is `Role.IsOwner`, not the id. `OwnerRoleID = "owner"` survives only for seeded data.

### Effective permissions

Role base ∪ channel overrides, resolved by `ChannelPermResolver`:

- `ResolveChannelPermissions(ctx, userID, channelID)` — cached.
- `ResolveChannelPermissionsFresh(...)` — bypasses the cache.

**The distinction is load-bearing.** A role or member-role change does not necessarily invalidate the
cache, so anything re-asserting permissions at the SFU must use the fresh variant or it will
re-grant something that was just revoked. See `voice_admin.go` and `voice_permission_enforce.go`.

Permission changes are enforced **mid-call**, not just at join: `EnforceChannelVoicePermissions`,
`EnforceServerVoicePermissions`, `EnforceUserVoicePermissions`. Losing `ConnectVoice` disconnects
the user and broadcasts `voice_force_disconnect`; keeping it re-asserts publish, preserving any
active server-mute.

## Middleware

`server/middleware/`: `auth.go`, `permission.go`, `server_membership.go`, `platform_admin.go`.

Context keys live in `pkg/ctxkeys` — `User`, `ServerID`, `Permissions`, `ClientRegion` — and
`middleware/layering_test.go` enforces that middleware never imports `handlers` again (see
`backend-layers.md`).

Rule: every endpoint authenticates, every mutating endpoint checks permission, every server-scoped
endpoint checks membership. The July security sweeps added tests for the cross-server case
specifically (`services/cross_server_ownership_test.go`), after
`fix(auth): enforce server ownership on server-scoped endpoints (IDOR)` and
`fix(security): close cross-server IDOR, invite waste, WS log-flood and voice-lock findings`.

**Known gap:** the WebSocket `voice_join` op has no permission check at all — see `websocket.md`.

## Rate limiting

`pkg/ratelimit`, token bucket per user. Wired in `init_services.go` as a `RateLimiters` struct:
login, message, register, forgot-password, reset-password, feedback, ICE, discovery, screen-share,
noise-reduction, DM-read, channel-read.

Two design notes worth keeping:
- **Denied reservations are cancelled** so the bucket refills correctly under load
  (`fix(ratelimit): cancel denied reservations so refill recovers under load`).
- Limiters are placed by **what an outcome costs**, not by success/failure. The screen-share token
  endpoint gates *before* the service call because both outcomes cost something — a success mints a
  4-hour JWT, a refusal writes an `app_logs` row. The screen-share fallback report deliberately
  shares that same bucket so one attempt cannot produce two log rows.

WS-level limits are separate and per connection — see `websocket.md`.

## File access

Three mechanisms, and they compose:

**1. Signed URLs** (`pkg/signedurl`, secret `MQVI_SIGNED_URL_SECRET`). **TTL is 1 hour.**

The rule that keeps being relearned: **store the unsigned URL, sign at every broadcast egress.** A
signed URL parked in long-lived in-memory state and rebroadcast later expires mid-session and starts
serving 401s. Voice state was the original offender; `models.VoiceState.AvatarURL` is stored raw and
signed in every broadcast path. `signedurl.SignIfNeeded` re-signs anything with under half its TTL
remaining, and refuses to launder a tampered URL.

**2. File-audience JWT** as a cookie fallback (`pkg/authcookie`) so in-app rendering survives a
signed URL expiring (`fix(files): cookie-auth fallback for /api/files…`).

**3. `pkg/fileacl`** — per-type upload directories and centralised path validation. Directory
listing is blocked on `/api/uploads` and `/static/landing`.

Uploads additionally enforce per-user quota (`MQVI_DEFAULT_QUOTA_BYTES`) and ClamAV scanning — see
`files-and-uploads.md`.

## Sessions and devices

`sessions` table plus a device model. A **device** is an installation and is the unit push tokens
register under; a **session** is one WebSocket connection. Both matter for multi-device correctness
— see `websocket.md` for how `sessionID` and `deviceID` are used to avoid ringing or notifying the
device that already acted.
