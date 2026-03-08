/**
 * EmojiPicker — @emoji-mart/react tabanlı zengin emoji seçici.
 *
 * 1800+ emoji, arama, skin tone, sık kullanılanlar (otomatik).
 * Tema renkleri CSS custom properties üzerinden uygulanır.
 *
 * Viewport-aware: Mount olduktan sonra picker'ın üst kenarı viewport
 * dışına çıkıyorsa "flipped" class eklenir ve aşağı doğru açılır.
 *
 * Kullanım yerleri:
 * - MessageInput: mesaja emoji ekleme
 * - Message: reaction ekleme (hover + bar picker)
 * - CreateChannelModal: channel/category ismine emoji ekleme
 * - ChannelSettings: channel/category rename'e emoji ekleme
 * - RoleSettings: role ismine emoji ekleme
 * - ChannelTree: sidebar inline rename'e emoji ekleme
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";

type EmojiPickerProps = {
  /** Emoji seçildiğinde çağrılır — native emoji string döner */
  onSelect: (emoji: string) => void;
  /** Picker kapatıldığında çağrılır */
  onClose: () => void;
};

function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { i18n } = useTranslation();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);

  // Viewport sığma kontrolü — picker mount olduktan sonra konumunu kontrol et.
  // Eğer üst kenarı viewport dışına çıkıyorsa, picker'ı aşağı doğru aç.
  useEffect(() => {
    if (!pickerRef.current) return;
    // MutationObserver veya rAF ile emoji-mart'ın render olmasını bekle
    const raf = requestAnimationFrame(() => {
      if (!pickerRef.current) return;
      const rect = pickerRef.current.getBoundingClientRect();
      if (rect.top < 0) {
        setFlipped(true);
      } else if (rect.bottom > window.innerHeight) {
        // Aşağı taşıyorsa yukarı aç (default zaten yukarı, bu durumda flip etme)
        setFlipped(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Click-outside: picker dışına tıklanırsa kapat
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    // Timeout ile ekle — aksi halde aynı click event'i hem butonu açar hem hemen kapatır
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Escape ile kapat
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleEmojiSelect = useCallback(
    (emoji: { native: string }) => {
      onSelect(emoji.native);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div
      className={`emoji-picker${flipped ? " emoji-picker-flipped" : ""}`}
      ref={pickerRef}
    >
      <Picker
        data={data}
        onEmojiSelect={handleEmojiSelect}
        locale={i18n.language === "tr" ? "tr" : "en"}
        theme="dark"
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        perLine={8}
        maxFrequentRows={2}
        navPosition="bottom"
        emojiSize={28}
        emojiButtonSize={36}
      />
    </div>
  );
}

export default EmojiPicker;
