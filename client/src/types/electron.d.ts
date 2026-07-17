/**
 * Electron preload API type declarations.
 *
 * Types for contextBridge.exposeInMainWorld("electronAPI", ...) in electron/preload.ts.
 * window.electronAPI is only available in Electron — undefined in browser mode.
 */

interface ElectronUpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseName?: string;
}

interface ElectronDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

/** A running game worth offering to share, as detected by game-probe.exe + electron/gameDetect.ts. */
export interface DetectedGame {
  name: string;
  pid: number;
  hwnd: number;
  /** desktopCapturer-shaped, so it feeds the existing share path unchanged. */
  sourceId: string;
  /** Which layer named it: a game library, the games list, or the GPU heuristic. */
  via: "library" | "list" | "gpu";
  /** Data URL, or null when the window has no icon. */
  icon: string | null;
}

interface ElectronDesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}

/** Audio capture header — format info from native audio-capture.exe */
interface ElectronCaptureAudioHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatTag: number; // 1=PCM, 3=IEEE_FLOAT
}

interface ElectronAPI {
  getVersion: () => Promise<string>;
  relaunch: () => Promise<void>;

  setFileAuthToken: (token: string, apiOrigin: string) => Promise<void>;
  clearFileAuthToken: () => Promise<void>;

  /** Whether update check was already performed at splash */
  wasUpdateChecked: () => Promise<boolean>;
  checkUpdate: () => Promise<ElectronUpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => Promise<void>;

  getDesktopSources: () => Promise<ElectronDesktopSource[]>;
  /** Main process requests screen picker — delivers sources */
  onShowScreenPicker: (cb: (sources: ElectronDesktopSource[]) => void) => void;
  /** Drop the screen-picker listener, so remounts don't stack duplicates */
  removeScreenPickerListener: () => void;
  /** Send user's selection back to main process (null = cancelled) */
  sendScreenPickerResult: (sourceId: string | null) => void;

  /** Start screen share audio capture for the picked source: a window captures only its
   *  own audio, a screen captures all system audio except ours. */
  startSystemCapture: (sourceId?: string | null) => Promise<void>;
  stopSystemCapture: () => Promise<void>;
  /** Remove all capture-related IPC listeners to prevent accumulation */
  removeCaptureListeners: () => void;
  onCaptureAudioHeader: (cb: (header: ElectronCaptureAudioHeader) => void) => void;
  onCaptureAudioData: (cb: (data: Uint8Array) => void) => void;
  onCaptureAudioStopped: (cb: () => void) => void;
  onCaptureAudioError: (cb: (msg: string) => void) => void;

  /** Host platform ("win32" | "darwin" | "linux"), for gating Windows-only paths. */
  platform: string;

  // ─── Native Game Capture (WGC + hardware encode → LiveKit as {userId}_ss) ───
  /** Start native game capture of the picked desktopCapturer source. Resolves once the helper is
   *  actually publishing (or failed) — `started: false` means fall back to getDisplayMedia. */
  startGameCapture: (opts: {
    url: string;
    token: string;
    e2eePassphrase: string;
    sourceId: string;
    /** Cap on the stream's height, from the screen-share quality setting. */
    maxHeight: number;
  }) => Promise<{ started: boolean; error?: string }>;
  stopGameCapture: () => Promise<void>;
  onGameCaptureStopped: (cb: (code: number) => void) => void;
  removeGameCaptureListeners: () => void;

  // ─── Game detection (the "Go Live" row) ───
  // Windows-only: elsewhere start is a no-op and nothing is pushed, so the row never appears.
  /** Begin watching for a running game. Call on voice join. */
  startGameDetection: () => Promise<void>;
  /** Stop watching. Call on voice leave. */
  stopGameDetection: () => Promise<void>;
  /** The game to offer, or null when there is nothing. */
  onGameDetected: (cb: (game: DetectedGame | null) => void) => void;
  removeGameDetectionListeners: () => void;
  /** Answer the next getDisplayMedia with this source instead of showing the picker. Consumed once;
   *  null clears it. Only sharp shares need this — smooth never calls getDisplayMedia. */
  setPrePickedSource: (sourceId: string | null) => Promise<void>;

  /** Register a key for global PTT detection (works when app is unfocused) */
  registerPTTShortcut: (keyCode: string) => Promise<boolean>;
  /** Unregister the global PTT shortcut */
  unregisterPTTShortcut: () => Promise<void>;
  /** PTT key pressed globally */
  onPTTGlobalDown: (cb: () => void) => void;
  /** PTT key released globally */
  onPTTGlobalUp: (cb: () => void) => void;
  /** Remove global PTT listeners to prevent accumulation */
  removePTTListeners: () => void;

  /** Register the global mute toggle (works when app is unfocused) */
  registerMuteShortcut: (binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }) => Promise<boolean>;
  unregisterMuteShortcut: () => Promise<void>;
  /** Mute toggle pressed globally */
  onMuteGlobalToggle: (cb: () => void) => void;
  removeMuteListeners: () => void;

  /** Register the global deafen toggle (works when app is unfocused) */
  registerDeafenShortcut: (binding: { code: string; ctrl: boolean; shift: boolean; alt: boolean }) => Promise<boolean>;
  unregisterDeafenShortcut: () => Promise<void>;
  /** Deafen toggle pressed globally */
  onDeafenGlobalToggle: (cb: () => void) => void;
  removeDeafenListeners: () => void;

  /** Save credentials encrypted with safeStorage */
  saveCredentials: (username: string, password: string) => Promise<void>;
  loadCredentials: () => Promise<{ username: string; password: string } | null>;
  clearCredentials: () => Promise<void>;

  /** Read all app settings */
  getAppSettings: () => Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean; transparentBackground: boolean }>;
  setAppSetting: (key: string, value: boolean) => Promise<void>;

  /** Custom titlebar window controls */
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => void;
  removeMaximizedListener: () => void;

  /** Windows taskbar overlay badge. count=0 removes badge. */
  setBadgeCount: (count: number, iconDataURL: string | null) => Promise<void>;
  /** Flash taskbar for incoming message/call attention */
  flashFrame: () => Promise<void>;

  /** Clipboard write via main process IPC — always works */
  writeClipboard: (text: string) => Promise<void>;

  /** Image clipboard write via main process IPC (renderer clipboard API is sandboxed) */
  writeClipboardImage: (data: Uint8Array) => Promise<void>;

  /** Seconds since last OS-level input (mouse/keyboard anywhere). For idle detection across apps. */
  getSystemIdleTime: () => Promise<number>;

  onUpdateAvailable: (cb: (info: ElectronUpdateInfo) => void) => void;
  onUpdateProgress: (cb: (progress: ElectronDownloadProgress) => void) => void;
  onUpdateDownloaded: (cb: () => void) => void;
  onUpdateError: (cb: (message: string) => void) => void;
}

declare global {
  interface Window {
    /** Only available in Electron, undefined in browser */
    electronAPI?: ElectronAPI;
  }
}

export {};
