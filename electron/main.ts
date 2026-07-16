/**
 * electron/main.ts — Electron main process.
 *
 * Manages app lifecycle, window management, system tray,
 * IPC handlers, and auto-update.
 */

import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  session,
  Tray,
  Menu,
  nativeImage,
  desktopCapturer,
  powerMonitor,
  safeStorage,
  screen,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { spawn, ChildProcess } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import path from "path";

/** Main application window reference */
let mainWindow: BrowserWindow | null = null;

// ─── App Settings (persist to disk) ───

/**
 * Electron-only app settings stored in %APPDATA%/mqvi/app-settings.json.
 * Read in main process before renderer loads (e.g., startMinimized check).
 */
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface AppSettings {
  /** Auto-start on Windows login */
  openAtLogin: boolean;
  /** Start minimized to system tray */
  startMinimized: boolean;
  /** Minimize to tray instead of closing on X button */
  closeToTray: boolean;
  /** Transparent window background — desktop shows through (requires restart) */
  transparentBackground: boolean;
  /** Persisted window position and size */
  windowBounds?: WindowBounds;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  openAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  transparentBackground: false,
};

/** Load settings from disk, falling back to defaults if missing or corrupt. */
function loadAppSettings(): AppSettings {
  try {
    const settingsPath = path.join(app.getPath("userData"), "app-settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      // Merge with defaults so new keys get default values
      return { ...DEFAULT_APP_SETTINGS, ...parsed };
    }
  } catch {
    // Silently fall back to defaults on corrupt file
  }
  return { ...DEFAULT_APP_SETTINGS };
}

/** Save settings to disk. */
function saveAppSettings(settings: AppSettings): void {
  try {
    const settingsPath = path.join(app.getPath("userData"), "app-settings.json");
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("[main] Failed to save app settings:", err);
  }
}

/** Cached settings — avoids disk reads on every IPC call */
let appSettings = loadAppSettings();

/** System tray reference — kept at module level to prevent GC */
let tray: Tray | null = null;

/**
 * When true, window close performs actual quit (tray Quit clicked).
 * When false (default), close hides window to tray.
 */
let isQuitting = false;

/**
 * Screen share audio capture child process.
 *
 * audio-capture.exe taps WASAPI process loopback in the mode that matches what is
 * being shared: a window share captures only that window's process tree, a monitor
 * share captures everything except our own tree (including it would echo remote
 * voice back to the people speaking).
 *
 * Lifecycle:
 *   1. Renderer starts screen share with audio → IPC "start-system-capture" (picked source)
 *   2. Main spawns audio-capture.exe in include- or exclude-mode
 *   3. Exe writes PCM header + data to stdout → forwarded to renderer via IPC
 *   4. Renderer creates AudioWorklet → MediaStreamTrack → LiveKit publishes
 *   5. Screen share stops → IPC "stop-system-capture" → kill child process
 */
let captureProcess: ChildProcess | null = null;

/**
 * Monotonically increasing capture generation ID.
 * Prevents stale exit/error handlers from a killed process from
 * interfering with a newer capture session. Each start increments
 * the ID; handlers check their captured ID against the current one.
 */
let captureGeneration = 0;

// Native game capture helper (WGC + hardware encode → LiveKit, published as {userId}_ss).
let gameCaptureProcess: ChildProcess | null = null;

/** Same purpose as captureGeneration: a superseded helper's exit must not clear the live one. */
let gameCaptureGeneration = 0;

/** The helper prints this once its track is published — see native/game-capture/src/main.rs. */
const GAME_CAPTURE_READY = "MQVI-READY";

/** Connect + publish budget. Past this the helper is considered failed and the app uses sharp. */
const GAME_CAPTURE_READY_TIMEOUT_MS = 15_000;

/** How long the helper gets to close its capture session and leave the room before we force it. */
const GAME_CAPTURE_EXIT_TIMEOUT_MS = 3_000;

/**
 * Ask the helper to exit, forcing it only if it won't.
 *
 * kill() on Windows is a straight TerminateProcess — Node can't signal a console-less child — so a
 * killed helper never runs its shutdown: the WGC session stays open (DWM keeps drawing the yellow
 * capture border over the shared screen) and it never leaves the LiveKit room (viewers keep a ghost
 * share until the SFU times it out). Closing stdin is the shutdown request it listens for.
 */
function endGameCapture(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    child.once("exit", finish);
    try {
      child.stdin?.end();
    } catch {
      // Already gone — the timeout below still resolves us.
    }

    timer = setTimeout(() => {
      console.warn("[main] Game capture ignored the stop request, terminating");
      child.kill();
      finish();
    }, GAME_CAPTURE_EXIT_TIMEOUT_MS);
  });
}

/**
 * Turn the picked desktopCapturer source into the helper's capture target.
 * Exact by construction: a window is addressed by HWND (a title can match another window), a
 * screen by its physical bounds (the picked monitor is not necessarily the primary one).
 */
async function resolveCaptureTarget(sourceId?: string): Promise<string[]> {
  if (sourceId?.startsWith("window:")) {
    return ["--window-handle", sourceId.split(":")[1]];
  }
  if (sourceId?.startsWith("screen:")) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const src = sources.find((s) => s.id === sourceId);
    const display = src
      ? screen.getAllDisplays().find((d) => String(d.id) === src.display_id)
      : undefined;
    if (!display) throw new Error(`no display matches ${sourceId}`);
    // Electron reports bounds in DIP; WGC works in physical pixels.
    const r = screen.dipToScreenRect(null, display.bounds);
    return ["--monitor-rect", `${r.x},${r.y},${r.width},${r.height}`];
  }
  throw new Error(`cannot capture source '${sourceId ?? ""}'`);
}

/**
 * Pre-launch update check result.
 * true = check completed (renderer should not re-check).
 * false = splash didn't run (dev mode) or check failed.
 */
let prelaunchUpdateChecked = false;

/** Whether the PCM header has been parsed from the capture process stdout */
let captureHeaderParsed = false;

/** Buffer for accumulating stdout data before header is fully read */
let captureHeaderBuffer = Buffer.alloc(0);

// ─── Global PTT (Push-to-Talk) ───

/**
 * PTT target: either a uiohook keycode or a mouse button. null = inactive.
 * When set, uIOhook keydown/keyup (or mousedown/mouseup) toggle the mic via IPC.
 */
let pttTargetKeycode: number | null = null;
let pttTargetMouseButton: number | null = null;

/** Whether uIOhook is currently running (started/stopped on demand) */
let uiohookRunning = false;

/**
 * A toggle-style global shortcut (mute / deafen). Unlike PTT (hold), these
 * fire once on the press that completes the combo. Bound to a keyboard key
 * (keycode) or a mouse button (mouseButton); exactly one is set. `isDown` is
 * the repeat guard — uIOhook re-fires keydown while a key is held.
 */
type ToggleShortcut = {
  keycode: number | null;
  mouseButton: number | null;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  isDown: boolean;
};

let muteShortcut: ToggleShortcut | null = null;
let deafenShortcut: ToggleShortcut | null = null;

/** Mouse token (stored by frontend) → uiohook mouse button number. */
const mouseTokenToUiohookButton: Record<string, number> = {
  Mouse3: 3, // middle
  Mouse4: 4, // back
  Mouse5: 5, // forward
};

/**
 * Map KeyboardEvent.code (stored by frontend) → uiohook native keycode.
 * Built from UiohookKey enum + manual entries for left/right modifier variants.
 */
const codeToUiohook: Record<string, number> = {
  // Letters — frontend stores "KeyA", "KeyB", etc.
  KeyA: UiohookKey.A, KeyB: UiohookKey.B, KeyC: UiohookKey.C,
  KeyD: UiohookKey.D, KeyE: UiohookKey.E, KeyF: UiohookKey.F,
  KeyG: UiohookKey.G, KeyH: UiohookKey.H, KeyI: UiohookKey.I,
  KeyJ: UiohookKey.J, KeyK: UiohookKey.K, KeyL: UiohookKey.L,
  KeyM: UiohookKey.M, KeyN: UiohookKey.N, KeyO: UiohookKey.O,
  KeyP: UiohookKey.P, KeyQ: UiohookKey.Q, KeyR: UiohookKey.R,
  KeyS: UiohookKey.S, KeyT: UiohookKey.T, KeyU: UiohookKey.U,
  KeyV: UiohookKey.V, KeyW: UiohookKey.W, KeyX: UiohookKey.X,
  KeyY: UiohookKey.Y, KeyZ: UiohookKey.Z,

  // Digits — frontend stores "Digit0", "Digit1", etc.
  Digit0: UiohookKey[0], Digit1: UiohookKey[1], Digit2: UiohookKey[2],
  Digit3: UiohookKey[3], Digit4: UiohookKey[4], Digit5: UiohookKey[5],
  Digit6: UiohookKey[6], Digit7: UiohookKey[7], Digit8: UiohookKey[8],
  Digit9: UiohookKey[9],

  // Modifiers — frontend differentiates left/right
  ControlLeft: UiohookKey.Ctrl, ControlRight: UiohookKey.CtrlRight,
  ShiftLeft: UiohookKey.Shift, ShiftRight: UiohookKey.ShiftRight,
  AltLeft: UiohookKey.Alt, AltRight: UiohookKey.AltRight,
  MetaLeft: UiohookKey.Meta, MetaRight: UiohookKey.MetaRight,

  // Common keys
  Space: UiohookKey.Space,
  Tab: UiohookKey.Tab,
  CapsLock: UiohookKey.CapsLock,
  Backquote: UiohookKey.Backquote,
  Minus: UiohookKey.Minus,
  Equal: UiohookKey.Equal,
  BracketLeft: UiohookKey.BracketLeft,
  BracketRight: UiohookKey.BracketRight,
  Backslash: UiohookKey.Backslash,
  Semicolon: UiohookKey.Semicolon,
  Quote: UiohookKey.Quote,
  Comma: UiohookKey.Comma,
  Period: UiohookKey.Period,
  Slash: UiohookKey.Slash,
  Enter: UiohookKey.Enter,
  Backspace: UiohookKey.Backspace,

  // Function keys
  F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3,
  F4: UiohookKey.F4, F5: UiohookKey.F5, F6: UiohookKey.F6,
  F7: UiohookKey.F7, F8: UiohookKey.F8, F9: UiohookKey.F9,
  F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,

  // Numpad
  Numpad0: UiohookKey.Numpad0, Numpad1: UiohookKey.Numpad1,
  Numpad2: UiohookKey.Numpad2, Numpad3: UiohookKey.Numpad3,
  Numpad4: UiohookKey.Numpad4, Numpad5: UiohookKey.Numpad5,
  Numpad6: UiohookKey.Numpad6, Numpad7: UiohookKey.Numpad7,
  Numpad8: UiohookKey.Numpad8, Numpad9: UiohookKey.Numpad9,
  NumpadMultiply: UiohookKey.NumpadMultiply,
  NumpadAdd: UiohookKey.NumpadAdd,
  NumpadSubtract: UiohookKey.NumpadSubtract,
  NumpadDecimal: UiohookKey.NumpadDecimal,
  NumpadDivide: UiohookKey.NumpadDivide,
  NumpadEnter: UiohookKey.NumpadEnter,
};

/** Start the native keyboard hook if not already running */
function startUiohook(): void {
  if (uiohookRunning) return;
  uIOhook.start();
  uiohookRunning = true;
  console.log("[main] uIOhook started for global PTT");
}

/** Stop the native keyboard hook */
function stopUiohook(): void {
  if (!uiohookRunning) return;
  uIOhook.stop();
  uiohookRunning = false;
  console.log("[main] uIOhook stopped");
}

/** Run the hook while any global shortcut is registered; stop when none are. */
function refreshUiohookState(): void {
  const anyActive =
    pttTargetKeycode !== null ||
    pttTargetMouseButton !== null ||
    muteShortcut !== null ||
    deafenShortcut !== null;
  if (anyActive) startUiohook();
  else stopUiohook();
}

/** Build a ToggleShortcut from a renderer ShortcutBinding, or null if unknown. */
function buildToggleShortcut(binding: {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}): ToggleShortcut | null {
  const mods = { ctrl: binding.ctrl, shift: binding.shift, alt: binding.alt, isDown: false };
  const mouseButton = mouseTokenToUiohookButton[binding.code];
  if (mouseButton !== undefined) {
    return { keycode: null, mouseButton, ...mods };
  }
  const keycode = codeToUiohook[binding.code];
  if (keycode === undefined) return null;
  return { keycode, mouseButton: null, ...mods };
}

/** Whether a keyboard event's key + modifiers match a keyboard toggle shortcut. */
function matchesToggle(e: { keycode: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, s: ToggleShortcut): boolean {
  return (
    s.keycode !== null &&
    e.keycode === s.keycode &&
    e.ctrlKey === s.ctrl &&
    e.shiftKey === s.shift &&
    e.altKey === s.alt
  );
}

/** Whether a mouse event's button + modifiers match a mouse toggle shortcut. */
function matchesToggleMouse(e: { button: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, s: ToggleShortcut): boolean {
  return (
    s.mouseButton !== null &&
    e.button === s.mouseButton &&
    e.ctrlKey === s.ctrl &&
    e.shiftKey === s.shift &&
    e.altKey === s.alt
  );
}

// ─── uIOhook event handlers (registered once, filter by pttTargetKeycode) ───

uIOhook.on("keydown", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    mainWindow?.webContents.send("ptt-global-down");
  }

  if (muteShortcut && matchesToggle(e, muteShortcut)) {
    if (!muteShortcut.isDown) {
      muteShortcut.isDown = true;
      mainWindow?.webContents.send("mute-global-toggle");
    }
  }

  if (deafenShortcut && matchesToggle(e, deafenShortcut)) {
    if (!deafenShortcut.isDown) {
      deafenShortcut.isDown = true;
      mainWindow?.webContents.send("deafen-global-toggle");
    }
  }
});

uIOhook.on("keyup", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    mainWindow?.webContents.send("ptt-global-up");
  }

  // Reset repeat guard when the main key of a toggle combo is released.
  if (muteShortcut && e.keycode === muteShortcut.keycode) muteShortcut.isDown = false;
  if (deafenShortcut && e.keycode === deafenShortcut.keycode) deafenShortcut.isDown = false;
});

// ─── uIOhook mouse handlers (side buttons for PTT / mute / deafen) ───

uIOhook.on("mousedown", (e) => {
  const m = { button: e.button as number, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey };

  if (pttTargetMouseButton !== null && m.button === pttTargetMouseButton) {
    mainWindow?.webContents.send("ptt-global-down");
  }

  if (muteShortcut && matchesToggleMouse(m, muteShortcut) && !muteShortcut.isDown) {
    muteShortcut.isDown = true;
    mainWindow?.webContents.send("mute-global-toggle");
  }

  if (deafenShortcut && matchesToggleMouse(m, deafenShortcut) && !deafenShortcut.isDown) {
    deafenShortcut.isDown = true;
    mainWindow?.webContents.send("deafen-global-toggle");
  }
});

uIOhook.on("mouseup", (e) => {
  const button = e.button as number;

  if (pttTargetMouseButton !== null && button === pttTargetMouseButton) {
    mainWindow?.webContents.send("ptt-global-up");
  }

  // Reset repeat guard when the toggle's mouse button is released.
  if (muteShortcut && button === muteShortcut.mouseButton) muteShortcut.isDown = false;
  if (deafenShortcut && button === deafenShortcut.mouseButton) deafenShortcut.isDown = false;
});

// ─── Window Bounds Persistence ───

/** Debounce timer for saving window bounds (avoid excessive disk writes on drag/resize) */
let boundsTimer: ReturnType<typeof setTimeout> | null = null;

/** Save current window bounds to settings (debounced). */
function persistWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    // getNormalBounds() returns pre-maximize/fullscreen bounds — use it when
    // maximized so restore position/size is preserved correctly
    const rect = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    appSettings.windowBounds = { ...rect, isMaximized };
    saveAppSettings(appSettings);
  }, 500);
}

/**
 * Validate that saved bounds are still visible on a connected display.
 * Returns true if at least part of the window is on-screen.
 */
function boundsVisibleOnScreen(bounds: WindowBounds): boolean {
  const { screen } = require("electron");
  const displays = screen.getAllDisplays();
  // Check if at least 100px of the window is visible on any display
  for (const display of displays) {
    const { x, y, width, height } = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, x + width) - Math.max(bounds.x, x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, y + height) - Math.max(bounds.y, y));
    if (overlapX > 100 && overlapY > 50) return true;
  }
  return false;
}

// ─── Window Creation ───
function createWindow(): void {
  // Restore saved bounds or use defaults
  const saved = appSettings.windowBounds;
  const useSaved = saved && boundsVisibleOnScreen(saved);

  const isTransparent = appSettings.transparentBackground;

  mainWindow = new BrowserWindow({
    // Default size — overridden by setBounds() below for saved position
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    // Transparent mode: fully transparent background, desktop shows through.
    // Normal mode: dark background to prevent white flash before CSS loads.
    transparent: isTransparent,
    ...(isTransparent ? {} : { backgroundColor: "#111111" }),
    // Frameless window — custom titlebar with -webkit-app-region: drag
    frame: false,
    // Hide until ready-to-show to avoid partially loaded content
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Two-step restore: move to target display first so Windows applies the
  // correct DPI context, then set size. Single setBounds() interprets size
  // in primary monitor's DPI which causes wrong dimensions on mixed-DPI.
  if (useSaved) {
    mainWindow.setPosition(saved!.x, saved!.y);
    mainWindow.setSize(saved!.width, saved!.height);
  }

  // Show window when ready (unless startMinimized is enabled)
  mainWindow.once("ready-to-show", () => {
    if (!appSettings.startMinimized) {
      if (useSaved && saved!.isMaximized) {
        mainWindow?.maximize();
      }
      mainWindow?.show();
    }
  });

  // Persist window bounds on move, resize, maximize, unmaximize
  mainWindow.on("move", persistWindowBounds);
  mainWindow.on("resize", persistWindowBounds);

  // Notify renderer of maximize state changes for titlebar icon toggle
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window-maximized-change", true);
    persistWindowBounds();
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window-maximized-change", false);
    persistWindowBounds();
  });

  // Remove default Electron menu bar
  Menu.setApplicationMenu(null);

  // Dev: Vite dev server, Prod: local dist file
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL("http://localhost:3030");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../client/dist/index.html"));
  }

  // F12 toggle DevTools (available in production too)
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Open external links (http/https/mailto/tel) in the OS default browser
  // instead of inside the Electron window. SPA routing uses history.pushState
  // which doesn't fire will-navigate, so app navigation is unaffected.
  const isExternalUrl = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (!["http:", "https:", "mailto:", "tel:"].includes(u.protocol)) return false;
      if (isDev && u.origin === "http://localhost:3030") return false;
      return true;
    } catch {
      return false;
    }
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isExternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // Right-click on images shows Copy/Save options. Other targets get no menu.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (params.mediaType !== "image" || !mainWindow) return;
    const win = mainWindow;
    const menu = Menu.buildFromTemplate([
      {
        label: "Copy image",
        click: () => win.webContents.copyImageAt(params.x, params.y),
      },
      {
        label: "Save image as…",
        click: () => win.webContents.downloadURL(params.srcURL),
      },
    ]);
    menu.popup({ window: win });
  });

  // ─── Close-to-Tray ───
  // isQuitting=true always closes; otherwise hide if closeToTray is enabled
  mainWindow.on("close", (e) => {
    if (!isQuitting && appSettings.closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Null reference after destroy to prevent "Object has been destroyed" crashes
  // from callbacks trying to access webContents during quit
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Permission Auto-Grant ───

/** Auto-grant media permissions (mic, camera, screen capture). */
function setupPermissions(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "display-capture", "mediaKeySystem", "fullscreen"];
      callback(allowed.includes(permission));
    }
  );

  // ─── getDisplayMedia Intercept — Custom Screen Picker ───
  //
  // Intercepts getDisplayMedia() to show a custom picker UI.
  // Sources are sent to renderer via IPC, user picks, result comes back.
  // VIDEO ONLY — audio is handled by audio-capture.exe (WASAPI process loopback)
  // to exclude our own voice chat audio from capture.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      // Chromium allows exactly one answer, and it reports an empty one — our way of cancelling,
      // which "Akıcı Görüntü" does on every share — by throwing back at us. That throw *is* the
      // rejection the renderer is waiting for. Treating it as a failure and answering again (which
      // is what the catch below used to do) earns a "callback was called more than once" and an
      // unhandled rejection on a share that is working fine.
      let answered = false;
      const answer = (streams: Electron.Streams) => {
        if (answered) return;
        answered = true;
        try {
          callback(streams);
        } catch (err) {
          if (streams.video) console.error("[main] Screen picker callback failed:", err);
        }
      };

      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
        });

        if (sources.length === 0) {
          answer({});
          return;
        }

        // Serialize sources with thumbnails as DataURLs
        const serialized = sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        }));

        // Send sources to renderer to display picker
        mainWindow?.webContents.send("show-screen-picker", serialized);

        // Wait for selection result from renderer (one-time listener)
        const sourceId = await new Promise<string | null>((resolve) => {
          ipcMain.once("screen-picker-result", (_event, id: string | null) => {
            resolve(id);
          });
        });

        if (sourceId) {
          // Find the selected source from original list
          const selected = sources.find((s) => s.id === sourceId);
          if (selected) {
            // Video only — no "loopback" audio.
            // Share audio comes from audio-capture.exe, scoped to this source and
            // started/stopped by the renderer via IPC.
            answer({ video: selected });
          } else {
            answer({});
          }
        } else {
          // User cancelled, or "Akıcı Görüntü" took the share
          answer({});
        }
      } catch (err) {
        console.error("[main] Screen picker failed:", err);
        answer({});
      }
    }
  );
}

// ─── System Tray ───

/** Create system tray icon with click-to-show and context menu. */
function createTray(): void {
  // macOS menu bar needs small icons. Use pre-generated 22x22 + 44x44 (@2x retina).
  const iconName = process.platform === "darwin" ? "tray-icon-22.png" : "mqvi-icon-256x256.png";
  const iconPath = path.join(__dirname, "../icons", iconName);
  tray = new Tray(nativeImage.createFromPath(iconPath));

  tray.setToolTip("mqvi");

  tray.on("click", () => {
    mainWindow?.show();
  });

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          mainWindow?.show();
        },
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

let fileAuthToken: string | null = null;
let fileAuthOrigin: string | null = null;

function setupFileAuthInjection(): void {
  const filter = { urls: ["http://*/api/files/*", "https://*/api/files/*"] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!fileAuthToken || !fileAuthOrigin) {
      callback({});
      return;
    }
    let reqOrigin: string;
    try {
      const u = new URL(details.url);
      reqOrigin = `${u.protocol}//${u.host}`;
    } catch {
      callback({});
      return;
    }
    if (reqOrigin !== fileAuthOrigin) {
      callback({});
      return;
    }
    const headers = { ...details.requestHeaders };
    if (!headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = `Bearer ${fileAuthToken}`;
    }
    callback({ requestHeaders: headers });
  });
}

// ─── IPC Handlers ───

/** Renderer → Main process IPC handlers. */
function setupIPC(): void {
  // App version from package.json
  ipcMain.handle("get-version", () => app.getVersion());

  // Seconds since last OS-level input (mouse/keyboard anywhere on the system).
  // Lets idle detection respect activity in other apps (games, browsers, etc.).
  ipcMain.handle("get-system-idle-time", () => powerMonitor.getSystemIdleTime());

  // Relaunch app — used by ConnectionSettings
  ipcMain.handle("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle("set-file-auth-token", (_event, token: string, apiOrigin: string) => {
    if (typeof token !== "string" || token.length === 0) return;
    if (typeof apiOrigin !== "string" || apiOrigin.length === 0) return;
    let normalized: string;
    try {
      const u = new URL(apiOrigin);
      normalized = `${u.protocol}//${u.host}`;
    } catch {
      return;
    }
    fileAuthToken = token;
    fileAuthOrigin = normalized;
  });
  ipcMain.handle("clear-file-auth-token", () => {
    fileAuthToken = null;
    fileAuthOrigin = null;
  });

  // ─── Auto-Updater IPC ───

  // Prevents duplicate update checks — renderer skips if splash already checked
  ipcMain.handle("was-update-checked", () => prelaunchUpdateChecked);

  // Update check and install from renderer
  ipcMain.handle("check-update", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo ?? null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("install-update", () => {
    // isSilent=true: no installer window, isForceRunAfter=true: auto-restart
    autoUpdater.quitAndInstall(true, true);
  });

  // ─── Desktop Capturer ───
  ipcMain.handle("get-desktop-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));
  });

  // ─── Screen Share Audio Capture ───
  // Renderer requests system audio capture (excluding our process).
  // This replaces Electron's built-in "loopback" which captures everything
  // including voice chat audio, causing echo for remote participants.

  ipcMain.handle("start-system-capture", (_event, sourceId?: string | null) => {
    // WASAPI process loopback is Windows-only
    if (process.platform !== "win32") {
      console.log("[main] System audio capture not available on this platform");
      return null;
    }

    // If a previous capture is still running, kill it first.
    // This handles rapid stop→start cycles where the old process
    // hasn't exited yet.
    if (captureProcess) {
      console.log("[main] Killing previous capture process before starting new one");
      captureProcess.kill();
      captureProcess = null;
    }

    // Increment generation — any exit/error handlers from previous
    // processes will see a stale generation and skip their cleanup.
    const thisGen = ++captureGeneration;

    // Resolve path to audio-capture.exe
    // Dev: native/audio-capture.exe (relative to project root)
    // Prod: resources/native/audio-capture.exe (inside asar extraResources)
    const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
    const exePath = isDev
      ? path.join(app.getAppPath(), "native", "audio-capture.exe")
      : path.join(process.resourcesPath, "native", "audio-capture.exe");

    // Sharing one window shares only that window's audio; sharing a monitor shares
    // everything we hear except ourselves. desktopCapturer window ids are
    // "window:<HWND>:<n>" on Windows — the exe resolves the HWND to its process and
    // degrades to exclude-mode if that window is stale or is one of ours.
    const hwnd =
      typeof sourceId === "string" && sourceId.startsWith("window:")
        ? sourceId.split(":")[1]
        : null;
    const args = hwnd
      ? ["--include-window", hwnd, "--self", process.pid.toString()]
      : ["--exclude", process.pid.toString()];

    console.log(`[main] Starting audio capture gen=${thisGen}: ${exePath} ${args.join(" ")}`);

    captureHeaderParsed = false;
    captureHeaderBuffer = Buffer.alloc(0);

    captureProcess = spawn(exePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // ─── Parse stdout: header (12 bytes) then raw PCM data ───
    captureProcess.stdout?.on("data", (chunk: Buffer) => {
      // Stale process — ignore its output
      if (thisGen !== captureGeneration) return;

      if (!captureHeaderParsed) {
        // Accumulate until we have the full 12-byte header
        captureHeaderBuffer = Buffer.concat([captureHeaderBuffer, chunk]);
        if (captureHeaderBuffer.length >= 12) {
          const sampleRate = captureHeaderBuffer.readUInt32LE(0);
          const channels = captureHeaderBuffer.readUInt16LE(4);
          const bitsPerSample = captureHeaderBuffer.readUInt16LE(6);
          const formatTag = captureHeaderBuffer.readUInt32LE(8);

          console.log(
            `[main] Audio capture format gen=${thisGen}: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit tag=${formatTag}`
          );

          // Send header info to renderer
          mainWindow?.webContents.send("capture-audio-header", {
            sampleRate,
            channels,
            bitsPerSample,
            formatTag,
          });

          captureHeaderParsed = true;

          // Forward remaining data after header
          const remaining = captureHeaderBuffer.subarray(12);
          if (remaining.length > 0) {
            mainWindow?.webContents.send("capture-audio-data", remaining);
          }
          captureHeaderBuffer = Buffer.alloc(0);
        }
      } else {
        // Forward raw PCM data to renderer
        mainWindow?.webContents.send("capture-audio-data", chunk);
      }
    });

    captureProcess.stderr?.on("data", (data: Buffer) => {
      if (thisGen !== captureGeneration) return;
      const msg = data.toString().trim();
      console.log(`[audio-capture] ${msg}`);
      // Forward stderr to renderer for debugging
      mainWindow?.webContents.send("capture-audio-error", msg);
    });

    captureProcess.on("exit", (code) => {
      console.log(`[main] Audio capture gen=${thisGen} exited with code ${code}`);
      // Stale process exit — a newer capture may already be running.
      // Do NOT null out captureProcess or send events to renderer.
      if (thisGen !== captureGeneration) {
        console.log(`[main] Ignoring stale exit (current gen=${captureGeneration})`);
        return;
      }
      mainWindow?.webContents.send("capture-audio-error", `EXIT code=${code}`);
      captureProcess = null;
      captureHeaderParsed = false;
      mainWindow?.webContents.send("capture-audio-stopped");
    });

    captureProcess.on("error", (err) => {
      if (thisGen !== captureGeneration) return;
      console.error("[main] Audio capture spawn error:", err);
      mainWindow?.webContents.send("capture-audio-error", `SPAWN ERROR: ${err.message}`);
      captureProcess = null;
      mainWindow?.webContents.send("capture-audio-stopped");
    });
  });

  // ─── Taskbar Badge (Windows Overlay Icon) ───
  ipcMain.handle(
    "set-badge-count",
    (_e: Electron.IpcMainInvokeEvent, count: number, iconDataURL: string | null) => {
      if (!mainWindow) return;
      if (count === 0 || !iconDataURL) {
        mainWindow.setOverlayIcon(null, "");
      } else {
        const icon = nativeImage.createFromDataURL(iconDataURL);
        mainWindow.setOverlayIcon(icon, `${count} unread`);
      }
      tray?.setToolTip(count > 0 ? `mqvi (${count})` : "mqvi");
    }
  );

  // ─── Flash Frame ───
  ipcMain.handle("flash-frame", () => {
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
  });

  // ─── Window Controls (Custom Titlebar) ───
  ipcMain.handle("minimize-window", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("maximize-window", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("close-window", () => {
    // Respects close-to-tray behavior
    mainWindow?.close();
  });

  // ─── Clipboard ───
  // clipboard.writeText in main process always works (preload is sandboxed)
  ipcMain.handle(
    "write-clipboard",
    (_e: Electron.IpcMainInvokeEvent, text: string) => {
      clipboard.writeText(text);
    }
  );

  // Image clipboard — the renderer's async clipboard API is unreliable in the
  // sandboxed context (same reason text is routed here), so write PNG bytes natively.
  ipcMain.handle(
    "write-clipboard-image",
    (_e: Electron.IpcMainInvokeEvent, data: Uint8Array) => {
      const img = nativeImage.createFromBuffer(Buffer.from(data));
      if (img.isEmpty()) throw new Error("decoded image is empty");
      clipboard.writeImage(img);
    }
  );

  // ─── App Settings (General / Windows Settings) ───

  ipcMain.handle("get-app-settings", () => {
    // Check actual OS state (user may have changed it via registry)
    const loginSettings = app.getLoginItemSettings();
    appSettings.openAtLogin = loginSettings.openAtLogin;
    return appSettings;
  });

  ipcMain.handle(
    "set-app-setting",
    (_e: Electron.IpcMainInvokeEvent, key: string, value: boolean) => {
      if (!(key in DEFAULT_APP_SETTINGS)) return;

      (appSettings as unknown as Record<string, boolean>)[key] = value;
      saveAppSettings(appSettings);

      // Sync with Windows registry
      if (key === "openAtLogin") {
        app.setLoginItemSettings({ openAtLogin: value });
      }
    }
  );

  ipcMain.handle("stop-system-capture", () => {
    if (process.platform !== "win32") return;
    if (captureProcess) {
      console.log("[main] Stopping audio capture gen=" + captureGeneration);
      captureProcess.kill();
      captureProcess = null;
      captureHeaderParsed = false;
      // Increment generation so the killed process's exit handler
      // won't send "capture-audio-stopped" to renderer
      captureGeneration++;
    }
  });

  // ─── Native Game Capture ───
  // Spawns mqvi-game-capture.exe (WGC capture + hardware encode). It joins the LiveKit room as
  // the "{userId}_ss" screen-share identity using the screen-token, so other clients subscribe
  // to it exactly like any screen share. Connection + capture params come from the renderer.
  ipcMain.handle(
    "start-game-capture",
    async (
      _e,
      opts: {
        url: string;
        token: string;
        e2eePassphrase: string;
        sourceId?: string;
        maxHeight?: number;
      }
    ): Promise<{ started: boolean; error?: string }> => {
      if (process.platform !== "win32") return { started: false, error: "windows only" };

      if (gameCaptureProcess) {
        const previous = gameCaptureProcess;
        gameCaptureProcess = null;
        gameCaptureGeneration++; // its exit is expected — don't report it as a helper death
        await endGameCapture(previous);
      }
      const thisGen = ++gameCaptureGeneration;

      let target: string[];
      try {
        target = await resolveCaptureTarget(opts.sourceId);
      } catch (err) {
        return { started: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (thisGen !== gameCaptureGeneration) return { started: false, error: "superseded" };

      const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
      const exePath = isDev
        ? path.join(app.getAppPath(), "native", "mqvi-game-capture.exe")
        : path.join(process.resourcesPath, "native", "mqvi-game-capture.exe");

      // The quality setting is a ceiling on the stream, not on the capture — the helper grabs the
      // source at its own size and scales down, so a 1440p monitor honours a 720p setting.
      const quality = opts.maxHeight ? ["--max-height", String(opts.maxHeight)] : [];
      const args = [...target, ...quality, "--config-stdin"];

      console.log(`[main] Starting game capture: ${exePath} ${args.join(" ")}`);

      let child: ChildProcess;
      try {
        child = spawn(exePath, args, {
          env: { ...process.env, RUST_LOG: "mqvi_game_capture=info" },
          // stdin carries the connection secrets, then stays open as the shutdown channel.
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return { started: false, error: err instanceof Error ? err.message : String(err) };
      }
      gameCaptureProcess = child;

      // Not the environment: on Windows any process running as this user can read another's
      // environment block without elevation, and the passphrase decrypts the whole room's audio
      // and video. A pipe is only readable by the two ends.
      child.stdin?.write(
        JSON.stringify({
          url: opts.url,
          token: opts.token,
          e2eePassphrase: opts.e2eePassphrase,
        }) + "\n"
      );

      // Spawning proves a process exists, not that anything is on the wire — the helper still has
      // to find the source, connect and publish. Report started only once it says so, so a failure
      // falls back to "Net Görüntü" instead of leaving a share that never appears.
      return await new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settle = (r: { started: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(r);
        };

        const forward = (d: Buffer) => {
          const msg = d.toString().trim();
          console.log(`[game-capture] ${msg}`);
          if (thisGen === gameCaptureGeneration) {
            mainWindow?.webContents.send("game-capture-log", msg);
          }
          if (msg.includes(GAME_CAPTURE_READY)) settle({ started: true });
        };
        child.stdout?.on("data", forward);
        child.stderr?.on("data", forward);

        child.on("exit", (code) => {
          console.log(`[main] Game capture exited code=${code}`);
          // A superseded helper must not clear the live one's handle (it would become unkillable)
          // nor tell the renderer that sharing stopped.
          if (thisGen === gameCaptureGeneration) {
            gameCaptureProcess = null;
            mainWindow?.webContents.send("game-capture-stopped", code);
          }
          settle({ started: false, error: `helper exited (code ${code})` });
        });

        child.on("error", (err) => {
          console.error("[main] Game capture spawn error:", err);
          if (thisGen === gameCaptureGeneration) {
            gameCaptureProcess = null;
            mainWindow?.webContents.send("game-capture-log", `SPAWN ERROR: ${err.message}`);
          }
          settle({ started: false, error: err.message });
        });

        timer = setTimeout(() => {
          // Same bookkeeping as every other path that ends a helper: drop the handle and retire
          // the generation, so this one's exit isn't reported to the renderer as a live helper
          // dying. It may already be capturing (and drawing the border) even though it never
          // published, so it still gets asked to stop rather than terminated.
          if (thisGen === gameCaptureGeneration) {
            gameCaptureProcess = null;
            gameCaptureGeneration++;
          }
          void endGameCapture(child);
          settle({ started: false, error: "helper did not start publishing in time" });
        }, GAME_CAPTURE_READY_TIMEOUT_MS);
      });
    }
  );

  ipcMain.handle("stop-game-capture", async () => {
    // This exit is expected: bump the generation so its handler doesn't report "stopped" to the
    // renderer as if the helper had died on its own.
    gameCaptureGeneration++;
    const child = gameCaptureProcess;
    gameCaptureProcess = null;
    if (child) {
      console.log("[main] Stopping game capture");
      await endGameCapture(child);
    }
  });

  // ─── Credential Storage (Remember Me) ───
  // Encrypted via Windows DPAPI (safeStorage), stored at %APPDATA%/mqvi/cred.enc

  const credPath = path.join(app.getPath("userData"), "cred.enc");

  ipcMain.handle(
    "save-credentials",
    (_e: Electron.IpcMainInvokeEvent, username: string, password: string) => {
      const data = JSON.stringify({ username, password });
      const encrypted = safeStorage.encryptString(data);
      writeFileSync(credPath, encrypted);
    }
  );

  ipcMain.handle("load-credentials", () => {
    try {
      if (!existsSync(credPath)) return null;
      const encrypted = readFileSync(credPath);
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted));
      return JSON.parse(decrypted) as { username: string; password: string };
    } catch {
      // Silently return null on corrupt file or decrypt failure
      return null;
    }
  });

  ipcMain.handle("clear-credentials", () => {
    try {
      if (existsSync(credPath)) unlinkSync(credPath);
    } catch {
      // Ignore deletion errors
    }
  });

  // ─── Global PTT (Push-to-Talk) Shortcut ───
  // Renderer tells us which key to watch; uIOhook fires keydown/keyup globally.

  ipcMain.handle(
    "register-ptt-shortcut",
    (_e: Electron.IpcMainInvokeEvent, keyCode: string) => {
      const mouseButton = mouseTokenToUiohookButton[keyCode];
      if (mouseButton !== undefined) {
        pttTargetMouseButton = mouseButton;
        pttTargetKeycode = null;
        refreshUiohookState();
        console.log(`[main] PTT registered: ${keyCode} → uiohook mouse ${mouseButton}`);
        return true;
      }

      const uiCode = codeToUiohook[keyCode];
      if (uiCode === undefined) {
        console.warn(`[main] Unknown PTT key code: ${keyCode}`);
        return false;
      }

      pttTargetKeycode = uiCode;
      pttTargetMouseButton = null;
      refreshUiohookState();
      console.log(`[main] PTT registered: ${keyCode} → uiohook ${uiCode}`);
      return true;
    }
  );

  ipcMain.handle("unregister-ptt-shortcut", () => {
    pttTargetKeycode = null;
    pttTargetMouseButton = null;
    refreshUiohookState();
    console.log("[main] PTT unregistered");
  });

  // ─── Global Mute / Deafen Toggle Shortcuts ───
  // Toggle-style: fire once per press, even when the app is unfocused (in-game).

  ipcMain.handle(
    "register-mute-shortcut",
    (_e: Electron.IpcMainInvokeEvent, binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }) => {
      const built = buildToggleShortcut(binding);
      if (!built) {
        console.warn(`[main] Unknown mute key code: ${binding.code}`);
        return false;
      }
      muteShortcut = built;
      refreshUiohookState();
      return true;
    }
  );

  ipcMain.handle("unregister-mute-shortcut", () => {
    muteShortcut = null;
    refreshUiohookState();
  });

  ipcMain.handle(
    "register-deafen-shortcut",
    (_e: Electron.IpcMainInvokeEvent, binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }) => {
      const built = buildToggleShortcut(binding);
      if (!built) {
        console.warn(`[main] Unknown deafen key code: ${binding.code}`);
        return false;
      }
      deafenShortcut = built;
      refreshUiohookState();
      return true;
    }
  );

  ipcMain.handle("unregister-deafen-shortcut", () => {
    deafenShortcut = null;
    refreshUiohookState();
  });
}

// ─── Auto Updater ───

/** Configure electron-updater for GitHub Releases auto-updates. */
function setupAutoUpdater(): void {
  // Auto-download when update is found
  autoUpdater.autoDownload = true;
  // Install on app quit
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info) => {
    mainWindow?.webContents.send("update-downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("update-error", err.message);
  });

  // Check for updates on launch + every 5 minutes
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5 * 60 * 1000);
}

// ─── Single Instance Lock ───
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running — quit this one
  app.quit();
} else {
  // Bring existing window to front when second instance is attempted
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Pre-Launch Update Check ───

/**
 * Pre-launch update check with splash window.
 * Shows splash, checks for updates, downloads if available, then launches app.
 * Skipped in dev mode.
 */
let updateWindow: BrowserWindow | null = null;

function createUpdateWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 380,
    height: 180,
    frame: false,
    resizable: false,
    center: true,
    transparent: false,
    alwaysOnTop: true,
    backgroundColor: "#111111",
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Inline HTML — logo injected via JS to avoid encodeURIComponent issues with base64
  const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: #111111; color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100vh; user-select: none;
      -webkit-app-region: drag;
    }
    .logo { width: 64px; height: 64px; margin-bottom: 16px; }
    .logo-text { font-size: 32px; font-weight: 800; color: #3b82f6; margin-bottom: 16px; }
    .status { font-size: 14px; color: #888; }
    .progress-wrap {
      width: 240px; height: 4px; background: #222222;
      border-radius: 2px; margin-top: 12px; overflow: hidden;
    }
    .progress-bar {
      height: 100%; width: 0%; background: #3b82f6;
      border-radius: 2px; transition: width 0.3s ease;
    }
  </style>
</head>
<body>
  <div id="logo-container"></div>
  <div class="status" id="status">Checking for updates...</div>
  <div class="progress-wrap"><div class="progress-bar" id="bar"></div></div>
  <script>
    window.setStatus = (text) => document.getElementById('status').textContent = text;
    window.setProgress = (pct) => document.getElementById('bar').style.width = pct + '%';
    window.setLogo = (dataUrl) => {
      const c = document.getElementById('logo-container');
      if (dataUrl) {
        c.innerHTML = '<img class="logo" src="' + dataUrl + '" alt="mqvi" />';
      } else {
        c.innerHTML = '<div class="logo-text">mqvi</div>';
      }
    };
  </script>
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Set logo after HTML loads via JS
  win.webContents.once("did-finish-load", () => {
    const logoPath = path.join(__dirname, "../icons/mqvi-icon-128x128.png");
    try {
      const logoBuffer = readFileSync(logoPath);
      const dataUrl = `data:image/png;base64,${logoBuffer.toString("base64")}`;
      win.webContents.executeJavaScript(`window.setLogo(${JSON.stringify(dataUrl)})`);
    } catch {
      win.webContents.executeJavaScript(`window.setLogo(null)`);
    }
  });

  return win;
}

async function checkForUpdateBeforeLaunch(): Promise<boolean> {
  // Skip update check in dev mode
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) return false;

  updateWindow = createUpdateWindow();

  try {
    autoUpdater.autoDownload = false;

    const result = await autoUpdater.checkForUpdates();
    // Mark as checked so renderer won't re-check
    prelaunchUpdateChecked = true;

    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      // No update — close splash, continue
      updateWindow.close();
      updateWindow = null;
      return false;
    }

    // Update available — show progress and download
    const newVersion = result.updateInfo.version;
    updateWindow.webContents.executeJavaScript(
      `window.setStatus('Downloading v${newVersion}...')`
    );

    autoUpdater.on("download-progress", (progress) => {
      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.webContents.executeJavaScript(
          `window.setProgress(${Math.round(progress.percent)})`
        );
      }
    });

    autoUpdater.on("update-downloaded", () => {
      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.webContents.executeJavaScript(
          `window.setStatus('Installing...'); window.setProgress(100)`
        );
      }
      // Brief delay then silent install and restart
      setTimeout(() => {
        autoUpdater.quitAndInstall(true, true);
      }, 1000);
    });

    await autoUpdater.downloadUpdate();
    return true; // Update downloading, app will restart
  } catch (err) {
    // Check failed — continue silently, mark as checked
    prelaunchUpdateChecked = true;
    console.error("[updater] pre-launch check failed:", err);
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.close();
    }
    updateWindow = null;
    return false;
  }
}

// ─── App Lifecycle ───

app.whenReady().then(async () => {
  setupPermissions();
  setupFileAuthInjection();

  // Pre-launch update check
  const updating = await checkForUpdateBeforeLaunch();
  if (updating) return; // Update downloading, quitAndInstall will be triggered

  setupIPC();
  setupAutoUpdater();
  createWindow();
  createTray();
});

// macOS: keep app running when all windows are closed
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS: recreate window when dock icon is clicked
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// Set isQuitting flag and clean up capture process + uIOhook before quit.
// We wait for the capture child process to exit gracefully so that Windows
// shutdown does not force-kill it mid-cleanup (which causes a visible
// STATUS_BREAKPOINT crash dialog).
let cleanupDone = false;
app.on("before-quit", (e) => {
  isQuitting = true;

  stopUiohook();
  pttTargetKeycode = null;
  pttTargetMouseButton = null;
  muteShortcut = null;
  deafenShortcut = null;

  if ((!captureProcess && !gameCaptureProcess) || cleanupDone) {
    // Nothing to wait for — let quit proceed
    return;
  }

  // Prevent quit until the capture children exit (or timeout)
  e.preventDefault();
  cleanupDone = true;

  const proc = captureProcess;
  captureGeneration++;
  captureProcess = null;

  // The game-capture helper gets the same graceful stop as anywhere else: terminating it would
  // leave its capture border on the shared screen and a ghost share in the room.
  const gameChild = gameCaptureProcess;
  gameCaptureGeneration++;
  gameCaptureProcess = null;
  const gameStopped = gameChild ? endGameCapture(gameChild) : Promise.resolve();

  const finish = () => {
    proc?.removeAllListeners("exit");
    void gameStopped.finally(() => app.quit());
  };

  if (!proc) {
    finish();
    return;
  }

  // If the process exits within 2s, quit immediately
  proc.on("exit", finish);

  // Safety net: don't block shutdown longer than 2 seconds
  setTimeout(finish, 2000);

  proc.kill();
});
