# mqvi-game-capture — NGC-01 spike

Standalone native process that publishes a **video track to the server-assigned LiveKit
instance with E2EE**. It is the de-risking spike for the native game-capture engine (WGC + NVENC):
before building any real capture or hardware encode, prove that a native process can publish into
our LiveKit rooms and that our app clients **decrypt and render** the result.

The source here is synthetic — an animated I420 test pattern — not a real screen. Real WGC capture
and NVENC encode come in NGC-02+.

## What it proves (NGC-01 acceptance)

An app client, subscribed to the room with the same passphrase, renders the moving test pattern
this process publishes — decrypted. That confirms **native → LiveKit → E2EE → our server** end to
end, and that the LiveKit client layer (`livekit-rust`) is the right choice.

## Why the E2EE just works

Our JS clients enable E2EE with `ExternalE2EEKeyProvider.setKey(passphrase)`, which derives the
frame key as `AES-128-GCM = PBKDF2(utf8(passphrase), salt="LKFrameEncryptionKey", SHA-256, 100000)`.
`livekit-rust`'s `KeyProvider::with_shared_key(KeyProviderOptions::default(), passphrase.as_bytes())`
uses the identical default salt + PBKDF2 over libwebrtc's native FrameCryptor — the same frame
format. So the room's `e2ee_passphrase` passed straight through yields frames our clients decrypt,
with no custom crypto on either side. (Details in `../../DECISIONS.md`, 2026-07-16 NGC-01 entry.)

## Build

Requires the Rust MSVC toolchain (installed: rustc 1.93.0) and MSVC build tools.

```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --manifest-path native\game-capture\Cargo.toml
```

- First build downloads a prebuilt libwebrtc via `webrtc-sys` (large, one-time).
- `.cargo/config.toml` forces the **static CRT** (`+crt-static`) so the link matches libwebrtc's
  `/MT`. Without it the link fails with LNK2038 (RuntimeLibrary mismatch). Keep that file.

Binary: `native\game-capture\target\debug\mqvi-game-capture.exe`.

## Live test

The native publisher joins as `{userId}_ss` and publishes an encrypted track. To prove **our JS
client** decrypts it, the viewer is a tiny page under `viewer/` that uses the *same* `livekit-client`
2.17 the app ships (vendored, same-origin — so its E2EE worker loads without CDN issues). It does
not depend on the app's screen-share UI, which does not yet surface native publishes (that wiring is
NGC-03/04).

You need **two accounts** in the same voice channel — this is inherent: the publisher's identity is
`{B}_ss` and the viewer must connect under a *different* identity `{A}` (LiveKit evicts duplicates).

### 1. Publisher token — account **B**

The screen-token endpoint requires B to be in the voice channel and returns the three values the
binary needs.

1. Log in as **B** (desktop app) and **join** the voice channel.
2. DevTools (`Ctrl+Shift+I`) → **Network** → find the `POST …/servers/{serverId}/voice/token`
   request from the join → right-click → **Copy → Copy as fetch** → paste into the **Console**.
3. Change the URL `…/voice/token` → `…/voice/screen-token`, run it, read the response:
   ```js
   const r = await fetch(/* …/voice/screen-token, same headers/body as copied */);
   console.log(await r.json());   // → data: { url, token, e2ee_passphrase }
   ```
   Copy `url`, `token`, `e2ee_passphrase`.

### 2. Viewer token — account **A** (different account)

1. Log in as **A**, **join** the same voice channel, and grab the `…/voice/token` response the same
   way (Network tab) → copy its `token` and `e2ee_passphrase` (the passphrase matches B's — it is
   per-room).
2. Then **leave** voice in A's app, so identity `{A}` is free for the viewer page (the JWT stays
   valid after leaving).

### 3. Run the publisher (account B's screen-token)

```powershell
cd native\game-capture
$env:LK_URL      = "wss://lk.…"     # B screen-token url
$env:LK_TOKEN    = "eyJ…"           # B screen-token token   (identity {B}_ss)
$env:LK_E2EE_KEY = "the-passphrase" # e2ee_passphrase
.\target\debug\mqvi-game-capture.exe
```
Flags also work (`--url … --token … --e2ee-key …`); optional `--width/--height/--fps`.
`$env:RUST_LOG="livekit=debug"` shows the SDK connect/E2EE internals.

### 4. Watch with the viewer page (account A's voice token)

Serve `viewer/` over localhost (WebRTC insertable streams need a secure context — `localhost` counts):

```powershell
npx --yes serve native\game-capture\viewer   # or: python -m http.server -d native\game-capture\viewer 8080
```
Open the printed `http://localhost:…` URL, paste **A's** `url` + `token` + `e2ee_passphrase`, click
**Connect & watch**.

- **Success:** the video shows a smoothly animating pattern — horizontal gradient, three colour
  columns, a white band scrolling down. That is the decrypted native stream. ✅ **NGC-01 holds.**
- **Green/noise or `E2EE ERROR` in the log:** track arrives but won't decrypt — passphrase mismatch.
  `LK_E2EE_KEY` (publisher) must equal the viewer's `e2ee_passphrase` exactly.
- **"no other participants":** publisher not connected / wrong room — check the publisher's log.

Stop the publisher with `Ctrl+C`; disconnect the viewer with its button.

> The vendored `viewer/*.mjs` are git-ignored; if missing, copy them from
> `client/node_modules/livekit-client/dist/` (see `viewer/.gitignore`).

## Next

**NGC-02** replaces the synthetic source with NVENC hardware-encoded frames fed through the same
`NativeVideoSource` seam, and settles the codec (H265/H264) + viewer-decode fallback.
