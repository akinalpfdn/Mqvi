/**
 * electron/preload.ts — Electron preload script.
 *
 * Exposes a safe API to the renderer process via contextBridge.
 * Accessible in renderer as window.electronAPI.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // ─── Invoke-style IPC (renderer → main → response) ───

  /** App version from package.json */
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),

  /** Relaunch the app — used by ConnectionSettings */
  relaunch: (): Promise<void> => ipcRenderer.invoke("relaunch"),

  setFileAuthToken: (token: string, apiOrigin: string): Promise<void> =>
    ipcRenderer.invoke("set-file-auth-token", token, apiOrigin),

  clearFileAuthToken: (): Promise<void> =>
    ipcRenderer.invoke("clear-file-auth-token"),

  /** Whether pre-launch update check ran — prevents duplicate checks in renderer */
  wasUpdateChecked: (): Promise<boolean> => ipcRenderer.invoke("was-update-checked"),

  /** Check for updates — returns UpdateInfo or null */
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("check-update"),

  /** Download the update */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke("download-update"),

  /** Install update and restart */
  installUpdate: (): Promise<void> => ipcRenderer.invoke("install-update"),

  /** List available screen/window sources for screen sharing */
  getDesktopSources: (): Promise<
    Array<{ id: string; name: string; thumbnail: string }>
  > => ipcRenderer.invoke("get-desktop-sources"),

  // ─── Screen Picker IPC ───

  /** Main process requests screen picker — receives sources */
  onShowScreenPicker: (
    cb: (sources: Array<{ id: string; name: string; thumbnail: string }>) => void
  ): void => {
    ipcRenderer.on("show-screen-picker", (_e, sources) => cb(sources));
  },

  /** Drop the screen-picker listener, so remounts don't stack duplicates */
  removeScreenPickerListener: (): void => {
    ipcRenderer.removeAllListeners("show-screen-picker");
  },

  /** Send user's selection to main process (null = cancelled) */
  sendScreenPickerResult: (sourceId: string | null): void => {
    ipcRenderer.send("screen-picker-result", sourceId);
  },

  // ─── Screen Share Audio Capture IPC ───
  // Uses native audio-capture.exe (WASAPI process loopback) to capture the audio
  // that belongs to the share, never our own — no voice echo.

  /** Start screen share audio capture. `sourceId` = the picked desktopCapturer source:
   *  a window shares only its own audio, a screen shares all system audio but ours. */
  startSystemCapture: (sourceId?: string | null): Promise<void> =>
    ipcRenderer.invoke("start-system-capture", sourceId ?? null),

  /** Stop system audio capture */
  stopSystemCapture: (): Promise<void> => ipcRenderer.invoke("stop-system-capture"),

  /** Host platform, so the renderer can gate Windows-only paths without a round trip. */
  platform: process.platform,

  // ─── Native Game Capture (WGC + hardware encode → LiveKit as {userId}_ss) ───

  /** Start native game capture of the picked desktopCapturer source. Resolves once the helper is
   *  actually publishing (or failed) — `started: false` means fall back to getDisplayMedia. */
  startGameCapture: (opts: {
    url: string;
    token: string;
    e2eePassphrase: string;
    sourceId: string;
    maxHeight: number;
  }): Promise<{ started: boolean; error?: string }> =>
    ipcRenderer.invoke("start-game-capture", opts),

  /** Stop native game capture */
  stopGameCapture: (): Promise<void> => ipcRenderer.invoke("stop-game-capture"),

  // ─── Game detection (the "Go Live" row) ───
  // Windows-only. Elsewhere start is a no-op and nothing is ever pushed, so the row never appears
  // rather than appearing and failing.

  /** Begin watching for a running game. Call on voice join. */
  startGameDetection: (): Promise<void> => ipcRenderer.invoke("start-game-detection"),

  /** Stop watching. Call on voice leave — the probe is not meant to outlive the row. */
  stopGameDetection: (): Promise<void> => ipcRenderer.invoke("stop-game-detection"),

  /** Answer the next getDisplayMedia with this source instead of showing the picker. Consumed once;
   *  pass null to clear. Only needed for sharp shares — smooth never goes through getDisplayMedia. */
  setPrePickedSource: (sourceId: string | null): Promise<void> =>
    ipcRenderer.invoke("set-prepicked-source", sourceId),

  /** The game to offer, or null when there is nothing. `sourceId` feeds the existing share path
   *  unchanged; `icon` is a data URL, absent when the window has none. */
  onGameDetected: (
    cb: (
      game: {
        name: string;
        pid: number;
        hwnd: number;
        sourceId: string;
        via: "library" | "list" | "gpu";
        icon: string | null;
      } | null
    ) => void
  ): void => {
    ipcRenderer.on("game-detected", (_e, game) => cb(game));
  },

  /** Drop the detection listener — without this a remount stacks another one on every join. */
  removeGameDetectionListeners: (): void => {
    ipcRenderer.removeAllListeners("game-detected");
  },

  /** Log lines (stdout/stderr) from the game-capture helper */
  onGameCaptureLog: (cb: (line: string) => void): void => {
    ipcRenderer.on("game-capture-log", (_e, line: string) => cb(line));
  },

  /** The game-capture helper exited (exit code; -1 = spawn error) */
  onGameCaptureStopped: (cb: (code: number) => void): void => {
    ipcRenderer.on("game-capture-stopped", (_e, code: number) => cb(code));
  },

  removeGameCaptureListeners: (): void => {
    ipcRenderer.removeAllListeners("game-capture-log");
    ipcRenderer.removeAllListeners("game-capture-stopped");
  },

  /**
   * Remove all capture-related IPC listeners.
   * MUST be called before registering new listeners in start() and during stop().
   * Without this, ipcRenderer.on() accumulates duplicate listeners across
   * screen share sessions — old listeners intercept events meant for new sessions.
   */
  removeCaptureListeners: (): void => {
    ipcRenderer.removeAllListeners("capture-audio-header");
    ipcRenderer.removeAllListeners("capture-audio-data");
    ipcRenderer.removeAllListeners("capture-audio-stopped");
    ipcRenderer.removeAllListeners("capture-audio-error");
  },

  /** Audio capture header received (format info) */
  onCaptureAudioHeader: (
    cb: (header: { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number }) => void
  ): void => {
    ipcRenderer.on("capture-audio-header", (_e, header) => cb(header));
  },

  /** Raw PCM audio data chunk from capture process */
  onCaptureAudioData: (cb: (data: Uint8Array) => void): void => {
    ipcRenderer.on("capture-audio-data", (_e, data) => cb(new Uint8Array(data)));
  },

  /** Audio capture process stopped (exited or error) */
  onCaptureAudioStopped: (cb: () => void): void => {
    ipcRenderer.on("capture-audio-stopped", () => cb());
  },

  /** Audio capture error/debug message from main process */
  onCaptureAudioError: (cb: (msg: string) => void): void => {
    ipcRenderer.on("capture-audio-error", (_e, msg) => cb(msg));
  },

  // ─── Global PTT (Push-to-Talk) Shortcut ───

  /** Register a key for global PTT detection (works even when app is unfocused) */
  registerPTTShortcut: (keyCode: string): Promise<boolean> =>
    ipcRenderer.invoke("register-ptt-shortcut", keyCode),

  /** Unregister the global PTT shortcut */
  unregisterPTTShortcut: (): Promise<void> =>
    ipcRenderer.invoke("unregister-ptt-shortcut"),

  /** PTT key pressed globally (main → renderer) */
  onPTTGlobalDown: (cb: () => void): void => {
    ipcRenderer.on("ptt-global-down", () => cb());
  },

  /** PTT key released globally (main → renderer) */
  onPTTGlobalUp: (cb: () => void): void => {
    ipcRenderer.on("ptt-global-up", () => cb());
  },

  /** Remove global PTT listeners to prevent accumulation across sessions */
  removePTTListeners: (): void => {
    ipcRenderer.removeAllListeners("ptt-global-down");
    ipcRenderer.removeAllListeners("ptt-global-up");
  },

  // ─── Global Mute / Deafen Toggle Shortcuts ───

  /** Register the global mute toggle (works even when app is unfocused) */
  registerMuteShortcut: (binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }): Promise<boolean> =>
    ipcRenderer.invoke("register-mute-shortcut", binding),
  unregisterMuteShortcut: (): Promise<void> =>
    ipcRenderer.invoke("unregister-mute-shortcut"),
  onMuteGlobalToggle: (cb: () => void): void => {
    ipcRenderer.on("mute-global-toggle", () => cb());
  },
  removeMuteListeners: (): void => {
    ipcRenderer.removeAllListeners("mute-global-toggle");
  },

  /** Register the global deafen toggle (works even when app is unfocused) */
  registerDeafenShortcut: (binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }): Promise<boolean> =>
    ipcRenderer.invoke("register-deafen-shortcut", binding),
  unregisterDeafenShortcut: (): Promise<void> =>
    ipcRenderer.invoke("unregister-deafen-shortcut"),
  onDeafenGlobalToggle: (cb: () => void): void => {
    ipcRenderer.on("deafen-global-toggle", () => cb());
  },
  removeDeafenListeners: (): void => {
    ipcRenderer.removeAllListeners("deafen-global-toggle");
  },

  // ─── Credential Storage (Remember Me) ───

  /** Save credentials encrypted via safeStorage */
  saveCredentials: (username: string, password: string): Promise<void> =>
    ipcRenderer.invoke("save-credentials", username, password),

  /** Load saved credentials (null if none) */
  loadCredentials: (): Promise<{ username: string; password: string } | null> =>
    ipcRenderer.invoke("load-credentials"),

  /** Clear saved credentials */
  clearCredentials: (): Promise<void> =>
    ipcRenderer.invoke("clear-credentials"),

  // ─── App Settings (General / Windows Settings) ───

  /** Read all app settings */
  getAppSettings: (): Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean }> =>
    ipcRenderer.invoke("get-app-settings"),

  /** Update a single app setting */
  setAppSetting: (key: string, value: boolean): Promise<void> =>
    ipcRenderer.invoke("set-app-setting", key, value),

  // ─── Window Controls (Custom Titlebar) ───

  /** Minimize window */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("minimize-window"),

  /** Toggle maximize / restore */
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke("maximize-window"),

  /** Close window (respects close-to-tray) */
  closeWindow: (): Promise<void> => ipcRenderer.invoke("close-window"),

  /** Listen for maximize/unmaximize changes (icon toggle) */
  onMaximizedChange: (cb: (isMaximized: boolean) => void): void => {
    ipcRenderer.on("window-maximized-change", (_e, val) => cb(val));
  },

  /** Remove maximize listener (on component unmount) */
  removeMaximizedListener: (): void => {
    ipcRenderer.removeAllListeners("window-maximized-change");
  },

  // ─── Taskbar Badge + Flash ───

  /** Set taskbar overlay badge icon (Windows). count=0 removes badge. */
  setBadgeCount: (count: number, iconDataURL: string | null): Promise<void> =>
    ipcRenderer.invoke("set-badge-count", count, iconDataURL),

  /** Flash taskbar icon to attract attention on new messages/calls */
  flashFrame: (): Promise<void> => ipcRenderer.invoke("flash-frame"),

  // ─── Clipboard ───

  /** Copy text to clipboard via main process IPC */
  writeClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke("write-clipboard", text),

  /** Copy a PNG image to clipboard via main process IPC (renderer clipboard API is sandboxed) */
  writeClipboardImage: (data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke("write-clipboard-image", data),

  /** Seconds since last OS-level input — for idle detection across the whole system */
  getSystemIdleTime: (): Promise<number> =>
    ipcRenderer.invoke("get-system-idle-time"),

  // ─── Event listeners (main → renderer) ───

  /** Update available */
  onUpdateAvailable: (cb: (info: unknown) => void): void => {
    ipcRenderer.on("update-available", (_e, info) => cb(info));
  },

  /** Download progress */
  onUpdateProgress: (cb: (progress: unknown) => void): void => {
    ipcRenderer.on("update-progress", (_e, progress) => cb(progress));
  },

  /** Download completed */
  onUpdateDownloaded: (cb: () => void): void => {
    ipcRenderer.on("update-downloaded", () => cb());
  },

  /** Update error */
  onUpdateError: (cb: (message: string) => void): void => {
    ipcRenderer.on("update-error", (_e, message) => cb(message));
  },
});
