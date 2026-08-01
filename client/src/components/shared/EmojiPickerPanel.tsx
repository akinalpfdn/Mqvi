/**
 * EmojiPickerPanel — @emoji-mart/react wrapper with viewport-aware positioning.
 *
 * Not imported directly. EmojiPicker.tsx lazy-loads this module so @emoji-mart/data (27 MB on
 * disk, and the bulk of it in the bundle) stays out of the initial load.
 */

import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import { useNarrowChat } from "../../hooks/useNarrowChat";
import { useAnchoredPicker } from "../../hooks/useAnchoredPicker";

export type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /**
   * Rendered inside the chat column. `.chat-area` is both `position:relative` and
   * `overflow-x:hidden`, so it is the containing block for an absolutely positioned popover AND
   * clips it — the picker was cut off at the column edge. Set this and the panel portals to
   * <body> instead: a centered sheet when the column is narrow, otherwise a popover anchored to
   * the button. Callers outside the chat column leave it off and keep the in-flow popover.
   */
  column?: boolean;
};

// Gap to the anchor (mirrors the 6px margin in CSS), clearance to the window edge, and the
// smallest panel still worth showing rather than collapsing to a sliver.
const GAP = 6;
const EDGE = 8;
const MIN_HEIGHT = 220;

function EmojiPickerPanel({ onSelect, onClose, column = false }: EmojiPickerProps) {
  const { i18n } = useTranslation();
  const narrow = useNarrowChat();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [flipped, setFlipped] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number>();

  const sheet = column && narrow;
  const anchored = column && !narrow;
  const { markerRef, box } = useAnchoredPicker(anchored, pickerRef);

  // In-flow variant (settings, channel rename, soundboard — outside the clipping column): pick the
  // roomier side and cap the panel to it, so a short window cannot push it off-screen.
  useEffect(() => {
    if (column) return;
    const anchor = pickerRef.current?.parentElement;
    if (!anchor) return;

    const place = () => {
      const node = pickerRef.current;
      if (!node) return;
      // The rename and name-field wrappers render the picker in flow and position the wrapper
      // themselves, so this geometry is not ours to compute.
      if (getComputedStyle(node).position !== "absolute") return;
      const rect = anchor.getBoundingClientRect();
      const above = rect.top - GAP - EDGE;
      const below = window.innerHeight - rect.bottom - GAP - EDGE;
      const openDown = below > above;
      setFlipped(openDown);
      setMaxHeight(Math.max(MIN_HEIGHT, Math.floor(openDown ? below : above)));
    };

    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [column]);

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

  let style: CSSProperties | undefined;
  if (anchored) {
    // Hidden until measured — one frame at the wrong coordinates reads as a flicker.
    style = box
      ? ({ top: box.top, left: box.left, "--emoji-picker-max-h": `${box.maxHeight}px` } as CSSProperties)
      : { visibility: "hidden" };
  } else if (maxHeight) {
    style = { "--emoji-picker-max-h": `${maxHeight}px` } as CSSProperties;
  }

  const content = (
    <div
      className={`emoji-picker${sheet ? " emoji-picker-sheet" : anchored ? " emoji-picker-anchored" : flipped ? " emoji-picker-flipped" : ""}`}
      ref={pickerRef}
      style={style}
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

  // Both chat-column variants escape `.chat-area`'s overflow/containment via a body portal. The
  // marker span stays behind so the anchored variant can still find the button it belongs to.
  if (sheet) {
    return createPortal(
      <>
        <div className="picker-backdrop" onClick={onClose} />
        {content}
      </>,
      document.body
    );
  }

  if (anchored) {
    return (
      <>
        <span ref={markerRef} className="picker-marker" aria-hidden="true" />
        {createPortal(content, document.body)}
      </>
    );
  }

  return content;
}

export default EmojiPickerPanel;
