/** EmojiPicker — @emoji-mart/react wrapper with viewport-aware positioning. */

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Narrow column → render as a centered bottom sheet portaled to <body> (never off-screen). */
  sheet?: boolean;
};

function EmojiPicker({ onSelect, onClose, sheet = false }: EmojiPickerProps) {
  const { i18n } = useTranslation();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);

  // Flip picker downward if it overflows the viewport top (inline popover only — the sheet
  // variant is bottom-anchored so it never needs flipping).
  useEffect(() => {
    if (sheet || !pickerRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (!pickerRef.current) return;
      const rect = pickerRef.current.getBoundingClientRect();
      if (rect.top < 0) {
        setFlipped(true);
      } else if (rect.bottom > window.innerHeight) {
        setFlipped(false);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [sheet]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    // Defer to avoid the same click that opened the picker immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
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

  // Pierce shadow DOM to make internal background transparent for frosted glass
  useEffect(() => {
    if (!pickerRef.current) return;
    const el = pickerRef.current.querySelector("em-emoji-picker");
    if (!el?.shadowRoot) return;
    const style = document.createElement("style");
    // Grid stays transparent (frosted host shows through), but category headers need an opaque
    // fill so emojis scrolling underneath don't bleed through the label.
    style.textContent = "#root { background-color: transparent !important; } .sticky { background-color: var(--bg-1, #191919) !important; }";
    el.shadowRoot.appendChild(style);
    return () => { style.remove(); };
  }, []);

  const content = (
    <div
      className={`emoji-picker${sheet ? " emoji-picker-sheet" : flipped ? " emoji-picker-flipped" : ""}`}
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
        dynamicWidth={sheet || undefined}
      />
    </div>
  );

  // Sheet variant escapes the message column's overflow/containment via a body portal.
  if (sheet) {
    return createPortal(
      <>
        <div className="picker-backdrop" onClick={onClose} />
        {content}
      </>,
      document.body
    );
  }

  return content;
}

export default EmojiPicker;
