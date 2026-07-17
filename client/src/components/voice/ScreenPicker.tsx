/**
 * ScreenPicker — Screen share source selection modal (Electron only).
 *
 * Flow: main process sends "show-screen-picker" IPC with desktopCapturer sources ->
 * user picks a source -> "screen-picker-result" IPC sends source ID back ->
 * cancel sends null -> main callback({}) cancels the stream.
 *
 * One share flow, two engines — picked here alongside audio:
 * - "Akıcı Görüntü" (smooth): the native WGC + hardware-encode helper. Selecting a source cancels
 *   getDisplayMedia and hands the share to the helper (falls back to sharp if it can't start).
 * - "Net Görüntü" (sharp): getDisplayMedia, as before.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";

interface PickerSource {
  id: string;
  name: string;
  thumbnail: string;
}

function ScreenPicker() {
  const { t } = useTranslation("voice");
  const [sources, setSources] = useState<PickerSource[] | null>(null);
  const [activeTab, setActiveTab] = useState<"screens" | "windows">("screens");
  /** Source id whose "Akıcı Görüntü" helper is starting up — blocks a second pick. */
  const [startingId, setStartingId] = useState<string | null>(null);
  /** Set when the user cancels while a helper is starting, so the pick in flight aborts. */
  const cancelledRef = useRef(false);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const setScreenShareAudio = useVoiceStore((s) => s.setScreenShareAudio);
  const screenShareMode = useVoiceStore((s) => s.screenShareMode);
  const setScreenShareMode = useVoiceStore((s) => s.setScreenShareMode);
  const startNativeSmoothCapture = useVoiceStore((s) => s.startNativeSmoothCapture);
  const stopNativeSmoothCapture = useVoiceStore((s) => s.stopNativeSmoothCapture);
  const setPickedShareSourceId = useVoiceStore((s) => s.setPickedShareSourceId);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.onShowScreenPicker((incoming) => {
      setSources(incoming);
    });

    return () => api.removeScreenPickerListener();
  }, []);

  const handleSelect = useCallback(
    async (source: PickerSource) => {
      if (startingId) return; // a pick is already in flight — a second one would start a 2nd share

      // Both engines' audio is scoped to this source — record it before either starts.
      setPickedShareSourceId(source.id);

      if (screenShareMode !== "smooth") {
        window.electronAPI?.sendScreenPickerResult(source.id);
        setSources(null);
        return;
      }

      // The helper must connect and publish before getDisplayMedia can be cancelled, so this
      // takes a moment. Mark the pick as in flight: the modal would otherwise look frozen, and
      // main is waiting on exactly one result — send it whatever happens, or it waits forever.
      setStartingId(source.id);
      cancelledRef.current = false;
      let started = false;
      try {
        started = await startNativeSmoothCapture(source.id);
      } catch (err) {
        console.error("[ScreenPicker] smooth capture failed:", err);
      }
      setStartingId(null);

      if (cancelledRef.current) {
        // Backed out while it was coming up. handleCancel already answered main, and the helper
        // may have published by now — stop it, or we'd be sharing what the user just cancelled.
        if (started) stopNativeSmoothCapture();
        return;
      }

      // The helper carries the video, so cancel getDisplayMedia; if it never started, fall
      // through to sharp with this same source.
      window.electronAPI?.sendScreenPickerResult(started ? null : source.id);
      setSources(null);
    },
    [
      startingId,
      screenShareMode,
      startNativeSmoothCapture,
      stopNativeSmoothCapture,
      setPickedShareSourceId,
    ]
  );

  const handleCancel = useCallback(() => {
    // Cancelling stays possible while a helper starts (it may take seconds, or hang) — flag it so
    // the pick in flight aborts instead of quietly turning into a share.
    if (startingId) cancelledRef.current = true;
    setPickedShareSourceId(null);
    window.electronAPI?.sendScreenPickerResult(null);
    setSources(null);
  }, [startingId, setPickedShareSourceId]);

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

  if (!sources) return null;

  // Group sources: screens (screen:*) and windows (window:*)
  const screens = sources.filter((s) => s.id.startsWith("screen:"));
  const windows = sources.filter((s) => s.id.startsWith("window:"));

  const activeSources = activeTab === "screens" ? screens : windows;

  return (
    <div className="sp-overlay" onClick={handleCancel}>
      <div className="sp-card" onClick={(e) => e.stopPropagation()}>
        <div className="sp-header">
          <h2 className="sp-title">{t("screenPickerTitle")}</h2>
          <button className="sp-close" onClick={handleCancel}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

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

        <div className="sp-grid">
          {activeSources.length === 0 ? (
            <div className="sp-empty">{t("screenPickerNoSources")}</div>
          ) : (
            activeSources.map((source) => (
              <button
                key={source.id}
                className={`sp-source${startingId === source.id ? " sp-source-starting" : ""}`}
                onClick={() => void handleSelect(source)}
                disabled={startingId !== null}
                title={source.name}
              >
                <div className="sp-thumbnail-wrap">
                  <img
                    src={source.thumbnail}
                    alt={source.name}
                    className="sp-thumbnail"
                    draggable={false}
                  />
                  {startingId === source.id && (
                    <span className="sp-starting">{t("screenPickerStarting")}</span>
                  )}
                </div>
                <span className="sp-source-name">{source.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="sp-footer">
          <div className="sp-mode">
            <span className="sp-audio-label">{t("screenModeLabel")}</span>
            <div className="sp-mode-opts">
              <button
                className={`sp-mode-opt${screenShareMode === "smooth" ? " sp-mode-opt-active" : ""}`}
                onClick={() => setScreenShareMode("smooth")}
              >
                <span className="sp-mode-name">{t("screenModeSmooth")}</span>
                <span className="sp-mode-hint">{t("screenModeSmoothHint")}</span>
              </button>
              <button
                className={`sp-mode-opt${screenShareMode === "sharp" ? " sp-mode-opt-active" : ""}`}
                onClick={() => setScreenShareMode("sharp")}
              >
                <span className="sp-mode-name">{t("screenModeSharp")}</span>
                <span className="sp-mode-hint">{t("screenModeSharpHint")}</span>
              </button>
            </div>
          </div>
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
