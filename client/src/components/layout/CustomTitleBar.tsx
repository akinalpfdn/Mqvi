/**
 * CustomTitleBar — Electron custom window titlebar.
 *
 * frame:false ile OS titlebar kaldırıldığında pencere kontrollerini
 * (minimize, maximize/restore, close) sağlar.
 *
 * -webkit-app-region: drag → bar üzerinden pencere sürüklenebilir
 * -webkit-app-region: no-drag → butonlar tıklanabilir kalır
 *
 * Maximize↔restore ikon toggle'ı main process'ten gelen
 * "window-maximized-change" event'i ile yapılır.
 *
 * Close butonu → close-to-tray (isQuitting=false → pencere gizlenir).
 */

import { useEffect, useState } from "react";

function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // Maximize/unmaximize event listener
    api.onMaximizedChange((val) => setIsMaximized(val));

    return () => {
      api.removeMaximizedListener();
    };
  }, []);

  function handleMinimize() {
    window.electronAPI?.minimizeWindow();
  }

  function handleMaximize() {
    window.electronAPI?.maximizeWindow();
  }

  function handleClose() {
    window.electronAPI?.closeWindow();
  }

  return (
    <div className="custom-titlebar">
      {/* Sol: drag alanı (boş) */}
      <div className="titlebar-drag-region" />

      {/* Sağ: pencere kontrolleri */}
      <div className="titlebar-controls">
        {/* Minimize */}
        <button className="titlebar-btn" onClick={handleMinimize}>
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        {/* Maximize / Restore */}
        <button className="titlebar-btn" onClick={handleMaximize}>
          {isMaximized ? (
            // Restore icon — iki üst üste kare (Windows standard)
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                d="M3 1h6v6h-1M1 3h6v6H1z"
              />
            </svg>
          ) : (
            // Maximize icon — tek kare
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>

        {/* Close (tray'e gönder) */}
        <button className="titlebar-btn close" onClick={handleClose}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              stroke="currentColor"
              strokeWidth="1.2"
              d="M1 1l8 8M9 1l-8 8"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default CustomTitleBar;
