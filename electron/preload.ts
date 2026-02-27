/**
 * electron/preload.ts — Electron preload script.
 *
 * contextBridge ile renderer process'e güvenli API expose eder.
 * Renderer'da window.electronAPI üzerinden erişilir.
 *
 * Güvenlik modeli:
 * - contextIsolation: true → renderer ve preload farklı JavaScript context'lerde çalışır
 * - contextBridge.exposeInMainWorld(): Sadece belirtilen fonksiyonlar renderer'a açılır
 * - ipcRenderer.invoke(): Main process'teki ipcMain.handle() handler'larını çağırır
 * - ipcRenderer.on(): Main process'ten renderer'a gönderilen event'leri dinler
 *
 * Tauri'deki @tauri-apps/api invoke() ve listen() fonksiyonlarının karşılığı.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  // ─── Invoke-style IPC (renderer → main → response) ───

  /** Uygulama versiyonunu al (package.json version) */
  getVersion: (): Promise<string> => ipcRenderer.invoke("get-version"),

  /** Uygulamayı yeniden başlat — ConnectionSettings'te kullanılır */
  relaunch: (): Promise<void> => ipcRenderer.invoke("relaunch"),

  /** Güncelleme kontrolü — UpdateInfo veya null döner */
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("check-update"),

  /** Güncellemeyi indir */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke("download-update"),

  /** Güncellemeyi kur ve uygulamayı yeniden başlat */
  installUpdate: (): Promise<void> => ipcRenderer.invoke("install-update"),

  /** Ekran paylaşımı için mevcut pencere/ekran kaynaklarını listele */
  getDesktopSources: (): Promise<
    Array<{ id: string; name: string; thumbnail: string }>
  > => ipcRenderer.invoke("get-desktop-sources"),

  // ─── Screen Picker IPC ───

  /** Main process ekran picker göstermek istediğinde — kaynakları alır */
  onShowScreenPicker: (
    cb: (sources: Array<{ id: string; name: string; thumbnail: string }>) => void
  ): void => {
    ipcRenderer.on("show-screen-picker", (_e, sources) => cb(sources));
  },

  /** Kullanıcının seçim sonucunu main process'e gönderir (null = iptal) */
  sendScreenPickerResult: (sourceId: string | null): void => {
    ipcRenderer.send("screen-picker-result", sourceId);
  },

  // ─── Process-Exclusive Audio Capture IPC ───
  // Uses native audio-capture.exe (WASAPI process loopback) to capture
  // system audio while excluding our own process tree — no voice echo.

  /** Start system audio capture (excludes Electron's own audio) */
  startSystemCapture: (): Promise<void> => ipcRenderer.invoke("start-system-capture"),

  /** Stop system audio capture */
  stopSystemCapture: (): Promise<void> => ipcRenderer.invoke("stop-system-capture"),

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

  // ─── Taskbar Badge + Flash ───

  /** Taskbar overlay badge icon ayarla (Windows). count=0 → badge kaldır. */
  setBadgeCount: (count: number, iconDataURL: string | null): Promise<void> =>
    ipcRenderer.invoke("set-badge-count", count, iconDataURL),

  /** Taskbar'da pencereyi flash et — mesaj/arama geldiğinde dikkat çeker */
  flashFrame: (): Promise<void> => ipcRenderer.invoke("flash-frame"),

  // ─── Event listeners (main → renderer) ───

  /** Güncelleme mevcut bilgisi geldiğinde */
  onUpdateAvailable: (cb: (info: unknown) => void): void => {
    ipcRenderer.on("update-available", (_e, info) => cb(info));
  },

  /** İndirme progress bilgisi geldiğinde */
  onUpdateProgress: (cb: (progress: unknown) => void): void => {
    ipcRenderer.on("update-progress", (_e, progress) => cb(progress));
  },

  /** İndirme tamamlandığında */
  onUpdateDownloaded: (cb: () => void): void => {
    ipcRenderer.on("update-downloaded", () => cb());
  },

  /** Güncelleme hatası oluştuğunda */
  onUpdateError: (cb: (message: string) => void): void => {
    ipcRenderer.on("update-error", (_e, message) => cb(message));
  },
});
