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
