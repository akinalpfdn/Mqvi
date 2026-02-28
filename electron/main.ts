/**
 * electron/main.ts — Electron ana (main) process.
 *
 * Uygulamanın yaşam döngüsünü, pencere yönetimini, sistem tray'ini,
 * IPC handler'larını ve auto-update mekanizmasını yönetir.
 *
 * Tauri'den geçiş nedenleri:
 * - Mikrofon/kamera izinleri: session.setPermissionRequestHandler ile auto-grant
 * - Ekran paylaşımı: setDisplayMediaRequestHandler ile native kontrol
 * - Auto-update: electron-updater ile GitHub Releases entegrasyonu
 *
 * Güvenlik:
 * - contextIsolation: true — renderer process Node.js API'lerine erişemez
 * - nodeIntegration: false — renderer'da require/import Node modülleri yasak
 * - Tüm IPC preload.ts üzerinden contextBridge ile expose edilir
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  Tray,
  Menu,
  nativeImage,
  desktopCapturer,
} from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess } from "child_process";
import path from "path";

/** Ana uygulama penceresi referansı */
let mainWindow: BrowserWindow | null = null;

/** Sistem tray referansı — GC'den korunması için modül seviyesinde tutulur */
let tray: Tray | null = null;

/**
 * Close-to-tray flag — modül seviyesinde tutulur.
 * true olduğunda pencere kapatma isteği gerçek kapatma olarak işlenir.
 * false iken (varsayılan) pencere kapatma → hide (tray'e küçült).
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

/** Whether the PCM header has been parsed from the capture process stdout */
let captureHeaderParsed = false;

/** Buffer for accumulating stdout data before header is fully read */
let captureHeaderBuffer = Buffer.alloc(0);

// ─── Pencere Oluşturma ───

/**
 * Ana BrowserWindow'u oluştur ve yükle.
 *
 * Dev modda Vite dev server'a (localhost:3030) bağlanır.
 * Production'da local dist/index.html dosyasını yükler.
 *
 * Pencere boyutları Tauri config ile aynı tutuldu:
 * - default: 1280x800
 * - min: 940x560
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Varsayılan Electron menü çubuğunu (File/Edit/View/Window/Help) kaldır.
  // mqvi bir chat uygulaması — browser tarzı menüye ihtiyaç yok.
  Menu.setApplicationMenu(null);

  // Dev: Vite dev server, Prod: local dist dosyası
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL("http://localhost:3030");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../client/dist/index.html"));
  }

  // F12 ile DevTools açma — production'da da debug için
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // ─── Close-to-Tray ───
  // Pencere kapatma talebi geldiğinde:
  // - isQuitting true → gerçek kapatma (quit/tray quit tıklandı)
  // - isQuitting false → pencereyi gizle (tray'e küçült)
  //
  // Tauri'deki aynı davranış: CloseRequested → window.hide()
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

// ─── Permission Auto-Grant ───

/**
 * Medya izinlerini otomatik kabul et.
 *
 * Tauri/WebView2'deki en büyük sorun: mikrofon ve kamera kullanırken
 * browser tarzı izin popup'u gösteriyordu. Electron'da session handler
 * ile bu izinleri otomatik verebiliriz — masaüstü uygulaması olarak
 * kullanıcı zaten uygulamayı kurarak güvendiğini göstermiştir.
 *
 * İzin verilen permission türleri:
 * - "media": Mikrofon ve kamera erişimi
 * - "display-capture": Ekran yakalama (getDisplayMedia)
 * - "mediaKeySystem": DRM medya (gerekirse)
 */
function setupPermissions(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "display-capture", "mediaKeySystem"];
      callback(allowed.includes(permission));
    }
  );

  // ─── getDisplayMedia Intercept — Kullanıcıya Picker Göster ───
  //
  // Renderer'da navigator.mediaDevices.getDisplayMedia() çağrıldığında
  // bu handler tetiklenir. useSystemPicker Electron 33'te Windows'ta
  // güvenilir çalışmıyor, bu yüzden custom picker UI kullanıyoruz.
  //
  // Akış:
  // 1. Renderer getDisplayMedia() çağırır → bu handler tetiklenir
  // 2. Handler desktopCapturer ile kaynakları alır (ekranlar + pencereler)
  // 3. Kaynaklar IPC ile renderer'a gönderilir ("show-screen-picker")
  // 4. Renderer picker modal gösterir, kullanıcı seçim yapar
  // 5. Renderer "screen-picker-result" IPC ile seçilen source ID'yi döner
  // 6. Handler callback ile source'u Electron'a verir → stream başlar
  //
  // Audio: VIDEO ONLY — audio is handled separately by our native
  // audio-capture.exe process which uses WASAPI process-exclusive loopback.
  // This prevents echo: our own voice chat audio is excluded from capture.
  // Electron's built-in "loopback" captures ALL system audio including
  // our voice chat, causing remote participants to hear their own voice.
  //
  // Cancel: Kullanıcı picker'da iptal ederse sourceId null gelir → callback({})
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

        // Kaynakları serialize et — thumbnail'ler DataURL olarak gönderilir
        const serialized = sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        }));

        // Renderer'a picker açması için event gönder
        mainWindow?.webContents.send("show-screen-picker", serialized);

        // Renderer'dan seçim sonucunu bekle (Promise ile one-time listener)
        const sourceId = await new Promise<string | null>((resolve) => {
          ipcMain.once("screen-picker-result", (_event, id: string | null) => {
            resolve(id);
          });
        });

        if (sourceId) {
          // Seçilen kaynağı orijinal sources listesinden bul
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
          // Kullanıcı iptal etti
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

/**
 * Sistem tray ikonu oluştur.
 *
 * Davranışlar:
 * - Sol tık: Pencereyi göster
 * - Sağ tık: Context menu (Show / Quit)
 *
 * Tauri'deki system_tray modülünün Electron karşılığı.
 */
function createTray(): void {
  const iconPath = path.join(__dirname, "../icons/mqvi-icon-256x256.png");
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

/**
 * Renderer → Main process IPC handler'ları.
 *
 * contextBridge.exposeInMainWorld ile expose edilen fonksiyonlar
 * ipcRenderer.invoke() ile bu handler'ları çağırır.
 *
 * Tauri'deki invoke() + listen() mekanizmasının Electron karşılığı.
 */
function setupIPC(): void {
  // Uygulama versiyonu — package.json'daki version
  ipcMain.handle("get-version", () => app.getVersion());

  // Uygulamayı yeniden başlat — ConnectionSettings'te kullanılır
  ipcMain.handle("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // ─── Auto-Updater IPC ───
  // Renderer'dan güncelleme kontrolü ve kurma talebi
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
    autoUpdater.quitAndInstall();
  });

  // ─── Desktop Capturer ───
  // Ekran paylaşımı için mevcut pencere/ekran kaynaklarını listele.
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
  // Renderer'dan gelen unread count + canvas dataURL ile taskbar overlay icon set eder.
  // count=0 → overlay kaldır, count>0 → kırmızı badge göster.
  // Tray tooltip da güncellenir.
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
  // Mesaj veya arama geldiğinde taskbar ikonunu yanıp söndür (dikkat çek).
  // Pencere focus alınca flash otomatik durur.
  ipcMain.handle("flash-frame", () => {
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
  });

  ipcMain.handle("stop-system-capture", () => {
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
}

// ─── Auto Updater ───

/**
 * electron-updater konfigürasyonu.
 *
 * GitHub Releases'ten güncelleme kontrol eder.
 * package.json'daki "build.publish" config'i kullanır:
 *   provider: "github", owner: "akinalpfdn", repo: "Mqvi"
 *
 * Tauri'deki plugin-updater'ın karşılığı.
 * Fark: electron-updater progress event'leri daha detaylı.
 */
function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
  });

  autoUpdater.on("download-progress", (progress) => {
    mainWindow?.webContents.send("update-progress", progress);
  });

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update-downloaded");
  });

  autoUpdater.on("error", (err) => {
    mainWindow?.webContents.send("update-error", err.message);
  });
}

// ─── Single Instance Lock ───
// Aynı anda sadece bir mqvi instance'ı çalışabilir.
// İkinci instance açılmaya çalışınca mevcut pencere öne getirilir,
// yeni instance kapanır. Bu, tray'de birden fazla ikon oluşmasını önler.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Başka bir instance zaten çalışıyor — bu instance'ı hemen kapat
  app.quit();
} else {
  // Bu birinci (veya tek) instance — ikinci instance denendiğinde
  // mevcut pencereyi öne getir
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
 * Uygulama penceresi açılmadan ÖNCE güncelleme kontrolü yapar.
 * Discord/Slack modeli: eski client yeni API'ye bağlanmadan güncelleme al.
 *
 * Akış:
 * 1. Küçük bir splash penceresi göster ("Güncellemeler kontrol ediliyor...")
 * 2. GitHub Releases'ten yeni versiyon var mı kontrol et
 * 3. Varsa → otomatik indir, kur, uygulamayı yeniden başlat
 * 4. Yoksa veya hata olursa → splash kapat, normal uygulamayı aç
 *
 * Dev modda (app.isPackaged === false) skip edilir.
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
    icon: path.join(__dirname, "../icons/mqvi-icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Minimal HTML — inline, dosya gerektirmez
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
          background: #1a1a2e; color: #e0e0e0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          height: 100vh; user-select: none;
          -webkit-app-region: drag;
        }
        .logo { font-size: 32px; font-weight: 800; color: #7c6cf0; margin-bottom: 16px; }
        .status { font-size: 14px; color: #888; }
        .progress-wrap {
          width: 240px; height: 4px; background: #2a2a40;
          border-radius: 2px; margin-top: 12px; overflow: hidden;
        }
        .progress-bar {
          height: 100%; width: 0%; background: #7c6cf0;
          border-radius: 2px; transition: width 0.3s ease;
        }
      </style>
    </head>
    <body>
      <div class="logo">mqvi</div>
      <div class="status" id="status">Checking for updates...</div>
      <div class="progress-wrap"><div class="progress-bar" id="bar"></div></div>
      <script>
        window.setStatus = (text) => document.getElementById('status').textContent = text;
        window.setProgress = (pct) => document.getElementById('bar').style.width = pct + '%';
      </script>
    </body>
    </html>
  `)}`);

  return win;
}

async function checkForUpdateBeforeLaunch(): Promise<boolean> {
  // Dev modda update check yapma
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) return false;

  updateWindow = createUpdateWindow();

  try {
    autoUpdater.autoDownload = false;

    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
      // Güncelleme yok — splash kapat, devam et
      updateWindow.close();
      updateWindow = null;
      return false;
    }

    // Güncelleme var — progress göster ve indir
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
      // Kısa bekleme sonra kur ve yeniden başlat
      setTimeout(() => {
        autoUpdater.quitAndInstall(false, true);
      }, 1000);
    });

    await autoUpdater.downloadUpdate();
    return true; // Güncelleme indiriliyor, uygulama yeniden başlayacak
  } catch (err) {
    // Güncelleme kontrolü başarısız — sessizce devam et
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

  // Pencere açılmadan önce güncelleme kontrolü
  const updating = await checkForUpdateBeforeLaunch();
  if (updating) return; // Güncelleme indiriliyor, quitAndInstall tetiklenecek

  setupIPC();
  setupAutoUpdater();
  createWindow();
  createTray();
});

// macOS: Tüm pencereler kapandığında uygulama kapanmasın (dock'ta kalsın)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS: Dock ikonuna tıklayınca pencere yoksa yeniden oluştur
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// Quit öncesi flag'i set et — close-to-tray'i bypass etmek için
app.on("before-quit", () => {
  isQuitting = true;
});
