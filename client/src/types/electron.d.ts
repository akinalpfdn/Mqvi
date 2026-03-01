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

/** Audio capture header — format info from native audio-capture.exe */
interface ElectronCaptureAudioHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatTag: number; // 1=PCM, 3=IEEE_FLOAT
}

/** Electron preload API — window.electronAPI üzerinden erişilir */
interface ElectronAPI {
  /** Uygulama versiyonunu al (package.json version) */
  getVersion: () => Promise<string>;

  /** Uygulamayı yeniden başlat */
  relaunch: () => Promise<void>;

  /** Splash'te update kontrolü yapıldı mı? */
  wasUpdateChecked: () => Promise<boolean>;

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

  /** Start process-exclusive system audio capture (excludes our own audio) */
  startSystemCapture: () => Promise<void>;

  /** Stop system audio capture */
  stopSystemCapture: () => Promise<void>;

  /** Remove all capture-related IPC listeners to prevent accumulation */
  removeCaptureListeners: () => void;

  /** Audio capture header received (format info from native exe) */
  onCaptureAudioHeader: (cb: (header: ElectronCaptureAudioHeader) => void) => void;

  /** Raw PCM audio data chunk from capture process */
  onCaptureAudioData: (cb: (data: Uint8Array) => void) => void;

  /** Audio capture process stopped (exited or error) */
  onCaptureAudioStopped: (cb: () => void) => void;

  /** Audio capture error/debug message from main process */
  onCaptureAudioError: (cb: (msg: string) => void) => void;

  /** Kullanıcı adı ve şifreyi safeStorage ile şifreli olarak kaydet */
  saveCredentials: (username: string, password: string) => Promise<void>;

  /** Kayıtlı credential'ları yükle (yoksa null) */
  loadCredentials: () => Promise<{ username: string; password: string } | null>;

  /** Kayıtlı credential'ları sil */
  clearCredentials: () => Promise<void>;

  /** Taskbar overlay badge icon ayarla (Windows). count=0 → badge kaldır. */
  setBadgeCount: (count: number, iconDataURL: string | null) => Promise<void>;

  /** Taskbar'da pencereyi flash et — mesaj/arama geldiğinde dikkat çeker */
  flashFrame: () => Promise<void>;

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
