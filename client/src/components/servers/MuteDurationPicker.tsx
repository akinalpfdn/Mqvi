/**
 * MuteDurationPicker — Sunucu sessize alma süresi seçimi.
 *
 * Portal-based popover — ContextMenu benzeri ama sadece mute duration
 * butonları gösterir. Tıklanan süriye göre serverStore.muteServer()
 * çağrılır ve toast gösterilir.
 *
 * CSS class'ları: .mute-picker, .mute-picker-btn
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";

type MuteDurationPickerProps = {
  serverId: string;
  x: number;
  y: number;
  onClose: () => void;
};

/** Mute duration seçenekleri — backend'in kabul ettiği format */
const DURATIONS = [
  { key: "mute1Hour", value: "1h" },
  { key: "mute8Hours", value: "8h" },
  { key: "mute1Week", value: "7d" },
  { key: "muteForever", value: "forever" },
] as const;

function MuteDurationPicker({ serverId, x, y, onClose }: MuteDurationPickerProps) {
  const { t } = useTranslation("servers");
  const muteServer = useServerStore((s) => s.muteServer);
  const addToast = useToastStore((s) => s.addToast);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dışına tıklama veya Escape ile kapatma
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Pozisyon düzeltme — ekranın dışına taşmayı önle
  useEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [x, y]);

  async function handleSelect(duration: string) {
    const ok = await muteServer(serverId, duration);
    if (ok) {
      addToast("success", t("serverMuted"));
    }
    onClose();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="mute-picker"
      style={{ left: x, top: y }}
    >
      {DURATIONS.map((d) => (
        <button
          key={d.value}
          className="mute-picker-btn"
          onClick={() => handleSelect(d.value)}
        >
          {t(d.key)}
        </button>
      ))}
    </div>,
    document.body
  );
}

export default MuteDurationPicker;
