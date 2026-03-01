/**
 * EmojiPicker — Basit, kütüphanesiz emoji seçici component.
 *
 * CSS class'ları: .emoji-picker, .emoji-picker-tabs, .emoji-picker-tab,
 * .emoji-picker-tab.active, .emoji-picker-grid, .emoji-picker-btn
 *
 * Tasarım:
 * - ~80 emoji, 6 kategori sekmesi
 * - Grid layout, her emoji bir buton
 * - Click-outside ile kapanır
 * - Dışarıya doğru büyüyen absolute pozisyonlu dropdown
 *
 * Neden kütüphane yok?
 * emoji-mart gibi kütüphaneler 200KB+ eklenti getirir.
 * Basit bir reaction sistemi için 80 emoji yeterli.
 * İleride genişletilmek istenirse custom emoji upload veya
 * daha büyük bir emoji seti eklenebilir.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

type EmojiPickerProps = {
  /** Emoji seçildiğinde çağrılır */
  onSelect: (emoji: string) => void;
  /** Picker kapatıldığında çağrılır */
  onClose: () => void;
};

/** Kategori tanımları — her biri bir sekme ve emoji listesi içerir */
type EmojiCategory = {
  /** i18n key'i */
  labelKey: string;
  /** Sekme ikonu (emoji) */
  icon: string;
  /** Kategorideki emojiler */
  emojis: string[];
};

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    labelKey: "emojiFrequent",
    icon: "⭐",
    emojis: ["👍", "❤️", "😂", "😮", "😢", "😡", "🎉", "🔥", "👀", "💯", "✅", "👎"],
  },
  {
    labelKey: "emojiPeople",
    icon: "😀",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂",
      "🙂", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘",
      "😋", "😛", "😜", "🤪", "😎", "🤗", "🤔", "🤐",
      "😬", "😳", "🥺", "😭", "😤", "🤯", "😱", "🥱",
    ],
  },
  {
    labelKey: "emojiGestures",
    icon: "👋",
    emojis: [
      "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️",
      "🤞", "🫰", "🤟", "🤘", "🤙", "👈", "👉", "👆",
      "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜",
      "👏", "🙌", "🫶", "👐", "🤲", "🙏", "💪", "🫡",
    ],
  },
  {
    labelKey: "emojiNature",
    icon: "🌿",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼",
      "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔",
      "🌸", "🌺", "🌻", "🌹", "🌿", "🍀", "🌈", "☀️",
    ],
  },
  {
    labelKey: "emojiFood",
    icon: "🍕",
    emojis: [
      "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓",
      "🍑", "🍒", "🥝", "🍕", "🍔", "🍟", "🌮", "🍿",
      "☕", "🍺", "🍷", "🧃", "🍰", "🎂", "🍩", "🍪",
    ],
  },
  {
    labelKey: "emojiObjects",
    icon: "💡",
    emojis: [
      "⚽", "🏀", "🎮", "🎲", "🎯", "🏆", "🎵", "🎸",
      "💡", "📱", "💻", "⌨️", "🖥️", "📷", "🔑", "🔒",
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
      "⭐", "🌟", "💫", "✨", "🔥", "💥", "💯", "🎉",
    ],
  },
];

function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { t } = useTranslation("chat");
  const [activeTab, setActiveTab] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);

  // Viewport sığma kontrolü — picker mount olduktan sonra konumunu kontrol et.
  // Eğer üst kenarı viewport dışına çıkıyorsa (top < 0), picker'ı aşağı doğru aç.
  // Bu, chat'in en üstündeki mesajlarda emoji picker'ın erişilemez olmasını önler.
  useEffect(() => {
    if (!pickerRef.current) return;
    const rect = pickerRef.current.getBoundingClientRect();
    if (rect.top < 0) {
      setFlipped(true);
    }
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

  const handleEmojiClick = useCallback(
    (emoji: string) => {
      onSelect(emoji);
      onClose();
    },
    [onSelect, onClose]
  );

  const category = EMOJI_CATEGORIES[activeTab];

  return (
    <div className={`emoji-picker${flipped ? " emoji-picker-flipped" : ""}`} ref={pickerRef}>
      {/* Kategori sekmeleri */}
      <div className="emoji-picker-tabs">
        {EMOJI_CATEGORIES.map((cat, i) => (
          <button
            key={cat.labelKey}
            className={`emoji-picker-tab${i === activeTab ? " active" : ""}`}
            onClick={() => setActiveTab(i)}
            title={t(cat.labelKey)}
          >
            {cat.icon}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="emoji-picker-grid">
        {category.emojis.map((emoji) => (
          <button
            key={emoji}
            className="emoji-picker-btn"
            onClick={() => handleEmojiClick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

export default EmojiPicker;
