# Client state

Verified against `main` at 2026-08-27. React + TypeScript + Vite, **Zustand** for global state.

## Store layout

`client/src/stores/` — ~30 stores plus `slices/` and `shared/`. Slice pattern, never one monolith.

Domain stores: `authStore`, `channelStore`, `messageStore`, `dmStore`, `memberStore`, `friendStore`,
`serverStore`, `voiceStore`, `p2pCallStore` (966 lines), `e2eeStore`, `channelPermissionStore`,
`joinRequestStore`, `blockStore`, `badgeStore`, `pinStore`, `inviteStore`, `soundboardStore`,
`voiceMessageStore`, `preferencesStore`.

UI stores: `uiStore`, `mobileStore`, `appFocusStore`, `toastStore`, `confirmStore`,
`fileViewerStore`.

`slices/`: `voiceSettingsSlice`, `voiceScreenShareSlice`, `voiceWsSlice`, `dmSettingsSlice`,
`dmWsSlice`. `shared/`: `dmSort`, `markReadTracking`, `messageUtils`, `voiceRecovery`.

Server state is store + WebSocket sync. **There is no React Query / SWR layer** — do not add a second
cache on top.

## Mutations go through stores, not components

An August refactor (`refactor(components): route ... through the store`, 08-11) moved channel,
category, member-moderation, server-settings, join-request, voice-chat and soundboard mutations out
of components and into stores. Components call hooks; hooks call stores; stores call services.
**Nothing skips a layer.**

One deliberate exception recorded in the same series: `refactor(servers): keep e2ee_enabled out of
the generic server update path` — the encryption flag must not ride the generic update, because a
generic path makes it easy to change accidentally.

## WebSocket event handling

`client/src/hooks/useWebSocket.ts` owns the socket; handlers are split by domain in `hooks/ws/`:
`channelEventHandlers`, `dmEventHandlers`, `voiceEventHandlers`, `systemEventHandlers`,
plus `resyncOpenTabs`.

**Recovery is two steps, not replay.** The server stamps a `seq` on every event but nothing consumes
it and there is no replay buffer. On reconnect: the `ready` payload does a full state resync, then
`resyncOpenTabs` re-fetches messages for tabs the user actually has open
(`fix(chat): recover messages the socket missed while backgrounded`, `fix(ws): recover open tabs and
reconnect when the network returns`).

`fix(client): refill every open conversation, not just the selected one` — the resync must cover all
open tabs, not the focused one.

## Caching decisions worth knowing

**Channel tree — stale-while-revalidate** (decision 2026-07-17). `channelStore.categoriesByServer`
caches per server. `switchToServer` snapshots the outgoing tree and paints the incoming one from
cache *synchronously*, then `fetchChannels` revalidates in the background. Loading state only when
nothing is cached; the live-tree swap is guarded by `activeServerId === serverId`.

This **reverses** an earlier explicit choice to blank the tree on switch to avoid a stale flash — the
cost of that was an empty tree until the network landed. Trade-off accepted: a re-visited server can
show a ≲100 ms stale tree. Cache is in-memory for the session only; permission-filtered and E2EE
trees are deliberately not persisted to disk. The cache is evicted when a server is left or deleted.

**Voice recovery is tab-scoped.** `stores/shared/voiceRecovery.ts` writes the joined channel to
`sessionStorage`, which is tab-local. Only the tab that joined auto-recovers after a reload; a fresh
tab must never claim voice just because the backend still remembers the user being in it.

## Mobile — two decisions that constrain layout

**Android soft keyboard drives a CSS variable; the window never resizes** (decision 2026-07-17).
`windowSoftInputMode` stays `adjustNothing`. A `ViewCompat.setWindowInsetsAnimationCallback` on the
WebView reads the IME inset per animation frame and injects
`--keyboard-inset = max(0, ime.bottom - navBar.bottom)px` onto `<html>`; `#root` folds it into
`padding-bottom`.

Rejected: `adjustResize` (unreliable on Android 15 edge-to-edge), the Capacitor Keyboard plugin's
`resize:"body"` (fights the fixed shell, fires only at start/end → jumpy), and the apply-insets
listener (one slot per view, owned by Capacitor on API 35+). The animation-callback slot is
independent and additive, and is the only one giving per-frame smoothness.

iOS, Electron and web are inert here — the var stays `0px`; iOS uses `resize:"native"`.

**`backdrop-filter` blur is off by default on Capacitor** (decision 2026-07-17). Not a
`hardwareConcurrency` heuristic — that asked the wrong question and let a mid-range Android ship
`blur(28px) saturate(170%)` per message bubble and per keystroke. Now `loadPersistedBlur()` returns
false on `Capacitor.isNativePlatform()` *after* the stored-preference read, so an explicit user
toggle still wins. Eight selectors that hardcoded their own blur read three purpose tokens:
`--overlay-backdrop` (4px), `--overlay-backdrop-sm` (2px), `--mc-btn-backdrop` (16px).

Mobile panels are solid `--bg-1` as a deliberate visual downgrade for framerate. Desktop unchanged.

## Native platform bridge

`client/src/utils/nativePlugins.ts` and `client/src/native/`.

- `APP_RESUME_EVENT` (`"mqvi:app-resume"`) is dispatched on Capacitor `appStateChange` when the app
  becomes active; `useWebSocket` listens and reconnects or probes.
- **`appStateChange` cannot be trusted on Android** — ask `App.getState()` instead. Several DM
  read-state fixes on 07-14 exist because of this
  (`fix(dm): ask the native app state instead of trusting Android's queued appStateChange event`).
- **`document.hasFocus()` and `visibilityState` are not reliable on mobile** either
  (`fix(dm): stop the read loop trusting document.hasFocus() on mobile`,
  `fix(dm): trust the native app state alone on mobile, not the WebView's visibilityState`).
- iOS PushKit/CallKit is bridged through the `P2PCall` plugin, wired by `hooks/useCallKit.ts`.

## Read state and notifications

DM read state syncs across devices, and the server **proves the read against a watermark instead of
trusting the client** (`refactor(push): prove the DM read against the watermark…`, 07-14). Related:
`fix(dm): stop the client claiming to have read messages it never showed`.

The read endpoints are rate-limited, and the push guarantee has to survive that
(`fix(push): stop the read limiter and the outstanding map from breaking the DM push guarantee`).

## Styling

**There is no Tailwind.** No Tailwind package is installed and there is no `@theme` block —
utility classes like `bg-background`, `w-sidebar` or `font-sans` do not exist and silently do
nothing if written. `CLAUDE.md` described them for months; that description was wrong and has been
corrected.

The real model: **CSS custom properties plus hand-written semantic classes.** Components carry
class names like `ub-game-row`; the styles for them live in `client/src/styles/globals.css`
(5047 lines, 64 distinct tokens) reading `var(--…)`. Only two CSS files exist in the whole
client: `globals.css` and `landing.css`.

Token families: `--bg-0..5` (surface layers), `--t0..3` (text), `--f-ui` / `--f-m` (Manrope,
Source Code Pro), `--input-*`, `--mobile-*`, `--overlay-backdrop*`, `--panel-bg`, `--picker-bg`,
`--keyboard-inset`.

**Themes are applied at runtime, not by CSS.** `client/src/styles/themes.ts` holds **11 palettes**
(`ocean`, `aurora`, `midnight`, `ember`, `deepTeal`, `crispLight`, `velvetNight`, `nordicFrost`,
`obsidianRose`, `sageTerminal`, `slateOcean`) and `applyTheme(id)` writes 27 of the tokens onto
`:root` with `root.style.setProperty()`. So a token's value at runtime may come from JavaScript,
not from the stylesheet — grepping `globals.css` alone will not tell you what colour something is.

**No inline colours, fonts or arbitrary pixel values in components.** New value → add a token, then
a class.

Minimum font size is **13px everywhere** (names, labels, badges, status text). The only exception is
notification count badges inside 16px circles. Voice: avatar ≥36px, name ≥13px.

Portalled/fixed elements use `--panel-bg`; anything embedded inside an already-frosted panel must use
`--picker-bg` or it washes out. There is **no shared Tooltip component** — every hover hint is a
native `title`.

Chat-column pickers pass `column` and portal to `<body>`; `.chat-area` both positions and clips them.

## Performance work already done

`perf/scale-hotpaths` (PR#33, 07-31) and the mobile perf series:
- typing has its own context so keystrokes stop redrawing the message list
- presence is sent only to the entitled audience
- emoji data and admin charts load on demand (bundle split)
- the roster query is scoped to the server's members
- `channel_reads` fan-out is indexed
- per-keystroke composer reflow removed

If adding to a hot path, check these first rather than re-deriving them.

## i18n

`react-i18next` + `i18next-browser-languagedetector`, `client/src/i18n/`. Namespaces: `common`,
`auth`, `channels`, `chat`, `settings` (and others added since). Language order: `localStorage` →
`navigator` → `en`.

**Every user-visible string goes through `t()`, and EN + TR are added together.** Adding a key to one
language only is a project-rule violation, not a style preference.

## Typecheck

`npx tsc -b` from `client/`. **Never `tsc --noEmit`** — with project references it checks nothing and
exits 0. Tests are `vitest run` (46 files / 401 tests as of 2026-08-22); lint is `eslint .`.
