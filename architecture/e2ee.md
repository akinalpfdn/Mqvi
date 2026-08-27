# End-to-end encryption

Verified against `main` at 2026-08-27. Landed 2026-03-04 and hardened continuously since.

## Three separate systems — do not conflate them

| What | Protocol | Where |
|---|---|---|
| **DMs (1-1)** | X3DH + Double Ratchet | `client/src/crypto/signalProtocol.ts` |
| **Channels (group)** | Sender Keys, distributed over 1-1 Signal sessions | `client/src/crypto/senderKeyProtocol.ts` |
| **Voice** | SFrame, per-room passphrase from the server | `services/voice_e2ee.go`, LiveKit `e2ee-worker` |

Voice E2EE is **not** the same trust model as messaging: the passphrase is generated server-side and
handed to every participant in the token response. It protects the media path from the SFU operator,
not from the mqvi server. Messaging keys never leave the client.

## Client crypto modules

`client/src/crypto/` — 18 files:

`signalProtocol.ts` (850 lines), `senderKeyProtocol.ts`, `dmEncryption.ts`, `channelEncryption.ts`,
`fileEncryption.ts`, `deviceManager.ts`, `keyStorage.ts` (693), `keyBackup.ts`, `sessionLock.ts`,
`e2eePayload.ts`, `types.ts`, plus seven test files (`signalRoundTrip`, `senderKey`, `multiDevice`,
`keyBackup`, `ratchetConcurrency`, `sessionLock`, `readWithProgress`).

**Primitives:** X25519 (ECDH), Ed25519 (signatures), HKDF-SHA-256, HMAC-SHA-256 (chain ratchet),
AES-256-GCM (message encryption).

**Why `@noble/curves` and not Web Crypto:** Electron's Chrome build lacked X25519 support (added in
Chrome 133). The library is audited by Cure53 and Trail of Bits. Do not "modernise" this to Web
Crypto without checking the minimum Chrome across Electron, iOS WKWebView and Android WebView.

Key material lives in **IndexedDB** (`keyStorage.ts`).

## Sender keys — the group path

Sender encrypts **once**; all N members decrypt the same ciphertext with their inbound sender key.
Distribution rides the 1-1 Signal sessions.

**Rotation: on member removal, every 100 messages, or every 7 days.** Removal-triggered rotation is
the one that matters for correctness — without it a removed member can still read new traffic.

## `sessionLock.ts` — read this before touching any ratchet code

The ratchet is a **load → mutate → save** cycle against IndexedDB, and a read hands back an
independent structured clone. Two overlapping operations both start from the same state and
**whichever saves last silently discards the other's advance** — a chain key step, a skipped-key
entry, or a message counter simply disappears.

The socket makes this easy to hit: inbound events are routed **without awaiting**, so two messages
on one conversation decrypt at the same time.

Properties of the lock, all deliberate:
- **Keyed, never global.** Decrypting a channel backlog touches many sessions and must stay parallel.
- **Not a nonce-reuse guard.** Both AES-GCM paths draw a fresh random IV per call. It exists purely
  to keep persisted ratchet state consistent.
- **Leaf-level and not reentrant.** Every holder must be a function that does not itself call
  another locked function on the same key. Nesting deadlocks.
- The queue tail always settles fulfilled, so one failure cannot poison the chain.

Guarded by `ratchetConcurrency.test.ts` and `sessionLock.test.ts`. Related fixes:
`fix(e2ee): serialize ratchet state so concurrent messages stop losing it` and
`fix(e2ee): make establishing a session and encrypting one operation` (07-31) — establishing and
encrypting had to become atomic, not two locked steps.

## Devices and key backup

A **device** is an installation with its own identity key; `models/device.go`, `services/device_service.go`.
Prekeys are pooled per device — `pkg.ErrPrekeyExhausted` and the `prekey_low` WS op exist for
refilling. `device_list_update`, `device_key_change` and `group_session_new` are the WS ops that keep
peers in sync.

**Key backup** (`keyBackup.ts`) is gated behind a **mandatory recovery password set on first setup**
(`feat(e2ee): mandatory recovery password on first setup`, 03-07). Keys are preserved on logout, not
wiped.

Multi-device DM fan-out and the X3DH round trip are covered end to end by
`test: cover hub routing, the key backup round-trip, and X3DH end to end` and
`test: cover sender-key channels and multi-device DM fan-out` (08-10).

## Server-side policy — the server does not trust the client's choice

Decision 2026-07-21, "The server enforces its own encryption policy".

**The server rejects a plaintext message on a conversation whose E2EE is on.** Previously the client
alone chose the encrypted or plaintext path and nothing validated it — a client that misread the
server's state (a deep link opened before the server list loads, or a server binary too old to send
`e2ee_enabled` at all) silently stored plaintext on a server that mandates encryption.

Cost: one indexed server lookup per channel message send. Deliberately **not cached and not joined
onto the channel row** (decision 2026-07-21, "Thumbnails are scanned, and the encryption flag is not
cached") — a stale cached flag points the wrong way for exactly as long as its TTL, and joining it
onto the channel query means touching every channel SELECT.

Coded errors: `encryption_required` and `encryption_not_available`, so the client can say why rather
than showing a generic send failure.

## Upgrade order — server before clients

Decision 2026-07-21, "Server upgrades before clients".

`ServerListItem.e2ee_enabled` is **typed optional** in TypeScript because that is what the wire can
actually carry: the field is new on both `GET /api/servers` and the WS ready payload, and mqvi is
self-hosted, so a new client against an old server is a real combination.

**The client fails closed** when it cannot tell whether a conversation is encrypted — it refuses to
send and says so, rather than degrading quietly. Treating absent as "not encrypted" would send
plaintext to a server that mandates encryption.

Operators must upgrade the server first. Revisit if a version handshake ever lands, so the client
can distinguish "old server" from "unknown server".

## Edit path — a class of bug that recurred

Encrypted **edits** broke three separate ways and each fix is worth knowing:

- `fix(e2ee): stop silently dropping encrypted message edits` — the edit path did not carry the
  ciphertext through.
- `fix(e2ee): purge plaintext the old edit path left on encrypted messages` — the earlier bug had
  left readable plaintext behind on encrypted rows. A fix that does not clean up what the bug wrote
  is half a fix.
- `fix(e2ee): require a sender device on encrypted edits` and
  `fix(e2ee): refuse locally when the device cannot encrypt yet`.

Also `fix(e2ee): decide encryption from the target server, not the active one` — the encryption
decision must follow the **message's destination**, not whatever server the UI happens to be showing.

## Init-state traps

`fix(e2ee): gate channel decryption on E2EE init status` and
`fix(e2ee): stop init state from hiding conversations it cannot read` are two sides of the same
problem: gating too little shows garbage, gating too much hides conversations the user could read.
Anything touching init state should check both directions.

## Files

`fileEncryption.ts` — attachments are encrypted client-side on E2EE conversations. Note the
interaction with `files-and-uploads.md`: thumbnails are also client-supplied and are scanned by the
server like any other upload.

## Voice E2EE and recording

`services/voice_e2ee.go` mints a 32-byte `crypto/rand` passphrase per room, base64url, **in memory
only**, deleted when the room empties for forward secrecy. Both the join token and the screen-share
token return it; the client refuses a token without one.

The SFrame worker (`livekit-client/e2ee-worker`) runs **in the renderer**, encrypting every outgoing
frame and decrypting every incoming one — which is why renderer throttling degrades audio in *both*
directions (see `packaging-and-release.md`).

**Server-side recording and transcription are incompatible with this.** LiveKit Egress cannot
decrypt SFrame. Any meeting-recording feature must first decide: disable E2EE for recorded rooms and
say so in the UI, hand the key to the recorder (no longer end-to-end), or record client-side.
