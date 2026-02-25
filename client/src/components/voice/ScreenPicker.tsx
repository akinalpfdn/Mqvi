/**
 * ScreenPicker — Ekran paylaşımı kaynak seçim modalı.
 *
 * Electron'da setDisplayMediaRequestHandler tetiklendiğinde main process
 * desktopCapturer ile kaynakları alır ve "show-screen-picker" IPC event'i
 * ile renderer'a gönderir. Bu component gelen kaynakları thumbnail grid
 * olarak gösterir.
 *
 * Akış:
 * 1. Main process → "show-screen-picker" event + sources dizisi
 * 2. Bu component açılır, kaynaklar "screens" ve "windows" olarak gruplanır
 * 3. Kullanıcı bir kaynak tıklar → "screen-picker-result" IPC ile source ID gönderilir
 * 4. İptal → null gönderilir → main callback({}) ile stream'i iptal eder
 *
 * Gruplar:
 * - Screens: source.id "screen:" ile başlar (tam ekranlar)
 * - Windows: source.id "window:" ile başlar (uygulama pencereleri)
 *
 * Design: Projedeki modal pattern kullanılır (modal-backdrop + centered card, vpIn animation).
 * CSS class prefix: "sp-" (screen picker).
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";

/** desktopCapturer source — main process'ten gelen serileştirilmiş kaynak */
interface PickerSource {
  id: string;
  name: string;
  thumbnail: string;
}

function ScreenPicker() {
  const { t } = useTranslation("voice");
  const [sources, setSources] = useState<PickerSource[] | null>(null);
  const [activeTab, setActiveTab] = useState<"screens" | "windows">("screens");
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const setScreenShareAudio = useVoiceStore((s) => s.setScreenShareAudio);

  // Main process'ten gelen "show-screen-picker" event'ini dinle
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.onShowScreenPicker((incoming) => {
      setSources(incoming);
    });
  }, []);

  // Kaynak seçildiğinde main process'e gönder ve modalı kapat
  const handleSelect = useCallback((sourceId: string) => {
    window.electronAPI?.sendScreenPickerResult(sourceId);
    setSources(null);
  }, []);

  // İptal — modal kapatılır, main process'e null gönderilir
  const handleCancel = useCallback(() => {
    window.electronAPI?.sendScreenPickerResult(null);
    setSources(null);
  }, []);

  // Escape tuşu ile iptal
  useEffect(() => {
    if (!sources) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleCancel();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sources, handleCancel]);

  // Modal kapalıysa render etme
  if (!sources) return null;

  // Kaynakları grupla: ekranlar (screen:) ve pencereler (window:)
  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => s.id.startsWith("window:"));

  const activeSources = activeTab === "screens" ? screens : windows;

  return (
    <div className="sp-overlay" onClick={handleCancel}>
      <div className="sp-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sp-header">
          <h2 className="sp-title">{t("screenPickerTitle")}</h2>
          <button className="sp-close" onClick={handleCancel}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tab bar — Screens / Windows */}
        <div className="sp-tabs">
          <button
            className={`sp-tab${activeTab === "screens" ? " sp-tab-active" : ""}`}
            onClick={() => setActiveTab("screens")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            {t("screenPickerScreens")}
            <span className="sp-tab-count">{screens.length}</span>
          </button>
          <button
            className={`sp-tab${activeTab === "windows" ? " sp-tab-active" : ""}`}
            onClick={() => setActiveTab("windows")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
            </svg>
            {t("screenPickerWindows")}
            <span className="sp-tab-count">{windows.length}</span>
          </button>
        </div>

        {/* Source grid */}
        <div className="sp-grid">
          {activeSources.length === 0 ? (
            <div className="sp-empty">{t("screenPickerNoSources")}</div>
          ) : (
            activeSources.map((source) => (
              <button
                key={source.id}
                className="sp-source"
                onClick={() => handleSelect(source.id)}
                title={source.name}
              >
                <div className="sp-thumbnail-wrap">
                  <img
                    src={source.thumbnail}
                    alt={source.name}
                    className="sp-thumbnail"
                    draggable={false}
                  />
                </div>
                <span className="sp-source-name">{source.name}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer — ses paylaşım toggle'ı */}
        <div className="sp-footer">
          <label className="sp-audio-toggle">
            <span className="sp-audio-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              {t("screenPickerShareAudio")}
            </span>
            <div className={`sp-switch${screenShareAudio ? " sp-switch-on" : ""}`}
              onClick={() => setScreenShareAudio(!screenShareAudio)}
            >
              <div className="sp-switch-thumb" />
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}

export default ScreenPicker;
