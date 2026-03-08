/**
 * CustomTitleBar — Electron frameless window controls.
 *
 * Provides minimize, maximize/restore, close buttons when frame:false.
 * Draggable via -webkit-app-region: drag on the bar itself.
 * Close button sends to tray (isQuitting=false → window hides).
 */

import { useEffect, useState } from "react";

function CustomTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

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
      <div className="titlebar-drag-region" />

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize}>
          <svg width="10" height="1" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button className="titlebar-btn" onClick={handleMaximize}>
          {isMaximized ? (
            // Restore icon (overlapping squares)
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                d="M3 1h6v6h-1M1 3h6v6H1z"
              />
            </svg>
          ) : (
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

        {/* Close → sends to tray */}
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
