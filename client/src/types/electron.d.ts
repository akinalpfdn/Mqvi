/**
 * Electron preload API type declarations.
 *
 * electron/preload.ts'deki contextBridge.exposeInMainWorld("electronAPI", ...)
 * ile expose edilen fonksiyonların tip tanımları.
 *
 * window.electronAPI sadece Electron ortamında mevcuttur.
 * Browser modunda undefined olur — bu yüzden optional (?) olarak tanımlanır.
 */

/** Güncelleme bilgisi — electron-updater'dan gelen UpdateInfo alt kümesi */
interface ElectronUpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseName?: string;
}

/** İndirme progress bilgisi */
interface ElectronDownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

/** Ekran paylaşımı kaynak bilgisi */
interface ElectronDesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}

/** Electron preload API — window.electronAPI üzerinden erişilir */
interface ElectronAPI {
  /** Uygulama versiyonunu al (package.json version) */
  getVersion: () => Promise<string>;

  /** Uygulamayı yeniden başlat */
  relaunch: () => Promise<void>;

  /** Güncelleme kontrolü */
  checkUpdate: () => Promise<ElectronUpdateInfo | null>;

  /** Güncellemeyi indir */
  downloadUpdate: () => Promise<boolean>;

  /** Güncellemeyi kur ve yeniden başlat */
  installUpdate: () => Promise<void>;

  /** Ekran paylaşımı kaynakları listele */
  getDesktopSources: () => Promise<ElectronDesktopSource[]>;

  /** Main process ekran picker açmak istediğinde — kaynakları alır */
  onShowScreenPicker: (cb: (sources: ElectronDesktopSource[]) => void) => void;

  /** Kullanıcının seçim sonucunu main process'e gönderir (null = iptal) */
  sendScreenPickerResult: (sourceId: string | null) => void;

  /** Güncelleme mevcut event'i dinle */
  onUpdateAvailable: (cb: (info: ElectronUpdateInfo) => void) => void;

  /** İndirme progress event'i dinle */
  onUpdateProgress: (cb: (progress: ElectronDownloadProgress) => void) => void;

  /** İndirme tamamlandı event'i dinle */
  onUpdateDownloaded: (cb: () => void) => void;

  /** Güncelleme hatası event'i dinle */
  onUpdateError: (cb: (message: string) => void) => void;
}

declare global {
  interface Window {
    /** Electron preload API — sadece Electron ortamında mevcut, browser'da undefined */
    electronAPI?: ElectronAPI;
  }
}

export {};
