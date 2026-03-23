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
  safeStorage,
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
interface AppSettings {
  /** Auto-start on Windows login */
  openAtLogin: boolean;
  /** Start minimized to system tray */
  startMinimized: boolean;
  /** Minimize to tray instead of closing on X button */
  closeToTray: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  openAtLogin: false,
  startMinimized: false,
  closeToTray: true,
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
 * Process-exclusive audio capture child process.
 *
 * audio-capture.exe uses WASAPI ActivateAudioInterfaceAsync with
 * PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE to capture all system
 * audio EXCEPT our own Electron process tree. This solves the screen share
 * echo problem: remote voice chat audio (played by our app) is excluded
 * from the capture, while game/music audio is still captured.
 *
 * Lifecycle:
 *   1. Renderer starts screen share with audio → IPC "start-system-capture"
 *   2. Main spawns audio-capture.exe with our PID
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
 * uiohook keycode that the user has bound for PTT.
 * null = no global PTT active (user not in voice or PTT mode disabled).
 * When set, uIOhook keydown/keyup for this code toggle the mic via IPC.
 */
let pttTargetKeycode: number | null = null;

/** Whether uIOhook is currently running (started/stopped on demand) */
let uiohookRunning = false;

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

// ─── uIOhook event handlers (registered once, filter by pttTargetKeycode) ───

uIOhook.on("keydown", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    mainWindow?.webContents.send("ptt-global-down");
  }
});

uIOhook.on("keyup", (e) => {
  if (pttTargetKeycode !== null && e.keycode === pttTargetKeycode) {
    mainWindow?.webContents.send("ptt-global-up");
  }
});

// ─── Window Creation ───
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    // Prevent white flash before CSS loads (matches --bg-0)
    backgroundColor: "#111111",
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

  // Show window when ready (unless startMinimized is enabled)
  mainWindow.once("ready-to-show", () => {
    if (!appSettings.startMinimized) {
      mainWindow?.show();
    }
  });

  // Notify renderer of maximize state changes for titlebar icon toggle
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window-maximized-change", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window-maximized-change", false);
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
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
        });

        if (sources.length === 0) {
          callback({});
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
            // Audio capture is handled by audio-capture.exe (process-exclusive)
            // which is started/stopped by the renderer via IPC.
            callback({ video: selected });
          } else {
            callback({});
          }
        } else {
          // User cancelled
          callback({});
        }
      } catch (err) {
        console.error("[main] Screen picker error:", err);
        callback({});
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

// ─── IPC Handlers ───

/** Renderer → Main process IPC handlers. */
function setupIPC(): void {
  // App version from package.json
  ipcMain.handle("get-version", () => app.getVersion());

  // Relaunch app — used by ConnectionSettings
  ipcMain.handle("relaunch", () => {
    app.relaunch();
    app.exit(0);
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

  // ─── Process-Exclusive Audio Capture ───
  // Renderer requests system audio capture (excluding our process).
  // This replaces Electron's built-in "loopback" which captures everything
  // including voice chat audio, causing echo for remote participants.

  ipcMain.handle("start-system-capture", () => {
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

    console.log(`[main] Starting audio capture gen=${thisGen}: ${exePath} (exclude PID ${process.pid})`);

    captureHeaderParsed = false;
    captureHeaderBuffer = Buffer.alloc(0);

    captureProcess = spawn(exePath, [process.pid.toString()], {
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
      const uiCode = codeToUiohook[keyCode];
      if (uiCode === undefined) {
        console.warn(`[main] Unknown PTT key code: ${keyCode}`);
        return false;
      }

      pttTargetKeycode = uiCode;
      startUiohook();
      console.log(`[main] PTT registered: ${keyCode} → uiohook ${uiCode}`);
      return true;
    }
  );

  ipcMain.handle("unregister-ptt-shortcut", () => {
    pttTargetKeycode = null;
    stopUiohook();
    console.log("[main] PTT unregistered");
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

// Set isQuitting flag and clean up capture process + uIOhook before quit
app.on("before-quit", () => {
  isQuitting = true;

  stopUiohook();
  pttTargetKeycode = null;

  if (captureProcess) {
    captureGeneration++;
    captureProcess.kill();
    captureProcess = null;
  }
});
