/**
 * DMMuteDurationPicker — DM sohbeti sessize alma süresi seçimi.
 *
 * MuteDurationPicker (servers/) ile aynı pattern — portal-based popover.
 * Tıklanan süreye göre dmStore.muteDM() çağrılır.
 *
 * CSS class'ları: .mute-picker, .mute-picker-btn (mevcut — reuse)
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";

type DMMuteDurationPickerProps = {
  channelId: string;
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

function DMMuteDurationPicker({ channelId, x, y, onClose }: DMMuteDurationPickerProps) {
  const { t } = useTranslation("dm");
  const muteDM = useDMStore((s) => s.muteDM);
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
    await muteDM(channelId, duration);
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

export default DMMuteDurationPicker;
