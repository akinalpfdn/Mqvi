/**
 * ScreenShareContextMenu — Ekran paylaşımı audio volume kontrolü.
 *
 * Screen share video panelinde sağ tıkla açılır.
 * Sadece screen share audio'sunu kontrol eder — kullanıcının mic
 * sesi bu slider'dan etkilenmez (bağımsız screenShareVolumes state).
 *
 * Portal ile document.body'ye render edilir — panel overflow:hidden'ı aşar.
 *
 * İçerik:
 * 1. Header: Monitor icon + paylaşan kullanıcı ismi
 * 2. Volume slider (0-200%)
 *
 * CSS class'ları: .voice-ctx-menu, .voice-ctx-header, .voice-ctx-body,
 * .voice-ctx-slider, .voice-ctx-range, .voice-ctx-vol-value
 * (VoiceUserContextMenu ile aynı class'lar — tutarlı görünüm)
 */

import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";

type ScreenShareContextMenuProps = {
  userId: string;
  displayName: string;
  position: { x: number; y: number };
  onClose: () => void;
};

function ScreenShareContextMenu({
  userId,
  displayName,
  position,
  onClose,
}: ScreenShareContextMenuProps) {
  const { t } = useTranslation("voice");
  const menuRef = useRef<HTMLDivElement>(null);

  // ─── Store Selectors ───
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const setScreenShareVolume = useVoiceStore((s) => s.setScreenShareVolume);
  const currentVolume = screenShareVolumes[userId] ?? 100;

  // ─── Dış tıklama + Escape ile kapatma ───
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    // Bir frame bekle — sağ tık event'inin kendisi "click outside" algılanmasın
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // ─── Pozisyon düzeltme — ekranın dışına taşmayı önle ───
  useEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [position]);

  // ─── Handler ───
  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setScreenShareVolume(userId, Number(e.target.value));
    },
    [userId, setScreenShareVolume]
  );

  return createPortal(
    <div
      ref={menuRef}
      className="voice-ctx-menu"
      style={{ left: position.x, top: position.y }}
    >
      {/* Header: Monitor icon + Name */}
      <div className="voice-ctx-header">
        {/* Monitor/screen icon */}
        <svg
          style={{ width: 32, height: 32, flexShrink: 0 }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z"
          />
        </svg>
        <span className="voice-ctx-header-name">{displayName}</span>
      </div>

      <div className="voice-ctx-body">
        {/* Label */}
        <div className="voice-ctx-label">{t("screenShareVolume")}</div>

        {/* Volume Slider */}
        <div className="voice-ctx-slider">
          <svg
            style={{ width: 14, height: 14 }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
            />
          </svg>
          <input
            type="range"
            min={0}
            max={200}
            value={currentVolume}
            onChange={handleVolumeChange}
            className="voice-ctx-range"
            style={{
              background: `linear-gradient(to right, var(--primary) ${(currentVolume / 200) * 100}%, var(--bg-5) ${(currentVolume / 200) * 100}%)`,
            }}
          />
          <span className="voice-ctx-vol-value">{currentVolume}%</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ScreenShareContextMenu;
