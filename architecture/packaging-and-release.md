# Packaging, native code and release

Verified against `main` at 2026-08-27. Current version **2.24.0**.

## Platforms

| Shell | Where | Notes |
|---|---|---|
| Desktop | `electron/` (main, preload, gameDetect, helperOutput, redact) | Electron **42**, electron-builder 26. Migrated from **Tauri** on 2026-02-25 |
| Mobile | `client/ios/App`, `client/android` | Capacitor **8** |
| Web | `client/` | same React app |

Electron `main.ts` is ~1950 lines and owns: window creation, tray, auto-update, global shortcuts
(`uiohook-napi`), the native capture/probe helpers, IPC, and the close-to-tray behaviour.

## electron-builder config (`package.json` → `build`)

```
appId          net.mqvi.app
productName    mqvi
artifactName   mqvi-setup.${ext}      ← FIXED. Never add ${version}.
npmRebuild     false                  ← keep it false
publish        github / akinalpfdn / Mqvi
win            nsis
mac            dmg + zip, arm64
linux           AppImage
```

**`artifactName` must not contain `${version}`.** The landing page downloads
`releases/latest/download/mqvi-setup.exe`; a versioned name breaks that URL. This is a stated project
rule, not a preference.

**`npmRebuild: false` is deliberate.** `uiohook-napi` ships prebuilt N-API binaries; letting
electron-builder rebuild native modules broke the build
(`fix(build): skip native rebuild, use uiohook-napi prebuilt N-API binaries`, 06-19).

## Auto-update

`electron-updater`, GitHub provider. The `latest*.yml` manifests are **required** — without them
auto-update simply does not work.

`*.blockmap` files enable differential updates: electron-updater diffs old and new blockmaps and
downloads only changed blocks, typically 5–15 MB instead of ~80 MB. **If the blockmap is not
uploaded, every update downloads the full installer.**

## Release assets

Produced by `.github/workflows/build-desktop.yml`, triggered on tags matching `v*`.

| Platform | Assets |
|---|---|
| Windows | `mqvi-setup.exe`, `mqvi-setup.exe.blockmap`, `latest.yml` |
| macOS | `mqvi-setup.dmg`, `mqvi-setup.dmg.blockmap`, `mqvi-setup.zip`, `mqvi-setup.zip.blockmap`, `latest-mac.yml` |
| Linux | `mqvi-setup.AppImage`, `latest-linux.yml` |
| Server | **`mqvi-server-linux-amd64`, `mqvi-server-linux-arm64`** |
| Installer | `install.sh` |

**`CLAUDE.md` says the server binary is not published. That is wrong** — the workflow builds both
architectures with `CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w"` and uploads them,
and `deploy/install.sh` downloads them. Verified against release v2.24.0.

## Release process

Tag-driven through CI. Do **not** use `gh release create` by hand.

1. Bump `package.json` version, `client/src/components/settings/SettingsNav.tsx` (`mqvi vX.Y.Z`),
   and add `release-notes/vX.Y.Z.md` — all in one commit.
2. Push the tag.

**CI hard-fails when `release-notes/<tag>.md` is missing or empty** (workflow line ~267–276). Notes
are English only — public repo. Generic placeholders are not acceptable.

## Windows build chain in CI

The Windows job compiles three native artefacts before packaging:
`audio-capture.exe`, `game-probe.exe`, `mqvi-game-capture.exe` (MSVC + Python 3.11 set up in the
workflow). macOS signs with an imported Apple certificate and notarises with an App Store Connect API
key. Linux needs extra apt deps for AppImage.

## Native code

| Component | Language | Job |
|---|---|---|
| `native/audio-capture` | C++/WASAPI | process-exclusive audio capture so screen-share audio has no echo |
| `native/game-probe` | C++ | reports which process drives the GPU 3D engine, plus its window |
| `native/game-capture` | **Rust** | WGC capture → Media Foundation hardware encode → publish to LiveKit |
| iOS plugins | Swift | PushKit/CallKit (`P2PCall`), native attachment picking, HEVC poster extraction, broadcast extension |

All Windows-only except the Swift ones. `gameDetect.ts` is Windows-only by construction — it shells
out to `game-probe.exe`.

### Native game capture (NGC) — decisions worth not re-deriving

Recorded in `DECISIONS.md` 2026-07-16, five entries:

- **LiveKit client layer is `livekit-rust`**, not raw libwebrtc-C++.
- **Hardware encode via our own Media Foundation MFT + LiveKit `PreEncoded`** path.
- **WGC capture survives a GPU-heavy game** — that was the thing being proven.
- **The helper announces readiness on a delivered frame**, not on process start; an encoder can die
  three distinct ways and all three are handled.
- **The helper's connection secrets travel over stdin, not the environment** — environment variables
  are visible to other processes.
- **The helper is asked to stop, never terminated.**
- **The helper addresses the picked source exactly** and reports when it is *really* publishing.
- **Screen-share audio is scoped to the shared source**, not the system.

Screen share is **one flow with two engines** — "Akıcı Görüntü" (smooth, native) and "Net Görüntü"
(sharp, browser). When smooth fails the client falls back to sharp and **reports it to the server**
(`RecordScreenShareFallback`), because every step that can fail happens on the user's machine and
would otherwise be invisible.

`perf(voice): register the capture pump with MMCSS so a busy game can't starve it` (08-14) — the
capture thread needs a scheduler class or a game preempts it.

## Renderer priority — the macOS voice bug

`electron/main.ts`, before the single-instance lock:

```
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
```

**Why:** a macOS game taking a native fullscreen Space leaves the mqvi window fully occluded, and
Chromium then backgrounds the renderer. That is not cosmetic here — the LiveKit **E2EE SFrame worker
runs in the renderer** and processes every audio frame in *both* directions, and the denoise
AudioWorklet sits on the mic path. Starved of priority they miss deadlines and voice degrades both
ways, immediately on opening the game (even at its main menu) and recovering the instant the window
is focused.

`webPreferences.backgroundThrottling: false` does **not** cover this — Electron documents it as
throttling "animations and timers" plus the Page Visibility API. Renderer process priority and
occlusion are a separate mechanism, reachable only from these switches, and they must be set before
the app is ready.

Companion: `useVoiceSuspensionBlocker` (client) → `set-voice-active` IPC → `powerSaveBlocker.start
("prevent-app-suspension")` while in a call, for macOS App Nap. **Preventive — App Nap involvement
was never confirmed.** Deliberately *not* `prevent-display-sleep`: a call must not stop the screen
sleeping.

The hook asserts state on every effect run, including a redundant `false`. **That redundancy is
load-bearing** — a renderer reload skips the cleanup and leaves the main process holding a blocker
nobody will release; the mount-time assert is what frees it. Do not "optimise" it into a
rising-edge-only call.

### The second layer: macOS Game Mode

The occlusion switches above are only half the story, and shipping them revealed the other half.
With the renderer no longer backgrounded, voice became usable during a game but still produced
regular pops and crackles — **in both directions at once**.

That symmetry is the diagnostic. The denoise worklet chain only touches the **outgoing** path, so
it cannot explain incoming pops; and disabling `AudioWorkletThreadRealtimePriority` changed
nothing, ruling out the worklet thread as the place the deadline was missed. What sits on both
directions is Chromium's **audio utility process**, which does capture and playout together.

**macOS Game Mode** lowers the system priority of background processes whenever a game goes
fullscreen. It needs Apple Silicon and macOS 14+, activates automatically, has no System Settings
pane, and can only be turned off per game from the menu-bar control while that game is fullscreen.
It is why a plain fullscreen window does not reproduce this but a game does.

Fix, darwin only:

```
app.commandLine.appendSwitch("disable-features", "AudioServiceSandbox");
```

`AudioServiceOutOfProcess` also works but is the worse trade — it moves audio into the browser
process, so a crashing audio driver takes the whole app down instead of a restartable utility
process. We drop the sandbox, not the process. See the 2026-08-27 entry in `DECISIONS.md`.

**Why this is not a general fix.** Discord and Steam have no such problem because their voice does
not run in a browser engine at all — Discord uses a native `discord_voice.node` module and the
renderer only draws UI. mqvi runs the whole voice path in the renderer: LiveKit's JS SDK, the
Web Audio graph, the E2EE worker. Moving voice native is the real architectural answer and stays
open; `native/game-capture` already proves a native process can join a LiveKit room with E2EE.

**Testing flags without a build.** Chromium switches apply per launch and are not persisted, so a
flag can be A/B tested against an installed app:

```
open -a mqvi --args --disable-features=AudioServiceSandbox
```

Two traps. The app must be **fully quit first** (Cmd+Q — the red close button only hides it when
close-to-tray is on), because `requestSingleInstanceLock` makes a second launch quit immediately
and focus the running instance, silently discarding the flag. And verify it actually applied:

```
ps aux | grep -q AudioServiceSandbox && echo "FLAG AKTIF" || echo "FLAG YOK"
```

Without that check a launch failure is indistinguishable from the flag not helping.

## Mobile specifics

- `client/ios/App/App/Info.plist` declares `UIBackgroundModes`: `audio`, `voip`,
  `remote-notification`. The **app process** stays alive in background; the **WKWebView content
  process does not**, which is the root of the iOS voice-drop issue (see `voice.md`).
- `client/android/local.properties` is machine-specific — let Studio regenerate it.
- Universal links: AASA on iOS, app links on Android, for `mqvi.net` invite/channel URLs.
- Android needed `windowSoftInputMode="adjustNothing"` plus a CSS var for the keyboard — see
  `client-state.md`.
- Building Android needs **JDK 21** (Capacitor 8 compiles `capacitor-android` with Java 21);
  the Go backend runs on JDK 17. Do not use the JDK 8 that is first on `PATH` on the Windows machine.

## Build commands

```
npm run electron:dev      # concurrently: vite dev + tsc -p electron + electron .
npm run electron:build    # client build + tsc -p electron + electron-builder
npx tsc -p electron/tsconfig.json
```

From `client/`: `npx tsc -b`, `npx vitest run`, `npx eslint .`.
