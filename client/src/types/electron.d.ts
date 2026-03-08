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

  /** Whether update check was already performed at splash */
  wasUpdateChecked: () => Promise<boolean>;
  checkUpdate: () => Promise<ElectronUpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => Promise<void>;

  getDesktopSources: () => Promise<ElectronDesktopSource[]>;
  /** Main process requests screen picker — delivers sources */
  onShowScreenPicker: (cb: (sources: ElectronDesktopSource[]) => void) => void;
  /** Send user's selection back to main process (null = cancelled) */
  sendScreenPickerResult: (sourceId: string | null) => void;

  /** Start process-exclusive system audio capture (excludes our own audio) */
  startSystemCapture: () => Promise<void>;
  stopSystemCapture: () => Promise<void>;
  /** Remove all capture-related IPC listeners to prevent accumulation */
  removeCaptureListeners: () => void;
  onCaptureAudioHeader: (cb: (header: ElectronCaptureAudioHeader) => void) => void;
  onCaptureAudioData: (cb: (data: Uint8Array) => void) => void;
  onCaptureAudioStopped: (cb: () => void) => void;
  onCaptureAudioError: (cb: (msg: string) => void) => void;

  /** Save credentials encrypted with safeStorage */
  saveCredentials: (username: string, password: string) => Promise<void>;
  loadCredentials: () => Promise<{ username: string; password: string } | null>;
  clearCredentials: () => Promise<void>;

  /** Read all app settings (openAtLogin, startMinimized, closeToTray) */
  getAppSettings: () => Promise<{ openAtLogin: boolean; startMinimized: boolean; closeToTray: boolean }>;
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
