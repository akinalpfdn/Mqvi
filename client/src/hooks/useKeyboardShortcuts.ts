/**
 * useKeyboardShortcuts — Global keyboard shortcuts hook.
 *
 * Shortcuts:
 * - Ctrl+K — Quick Switcher toggle (works even in input focus, like Discord)
 * - Ctrl+Shift+M — Mute toggle (not in input)
 * - Ctrl+Shift+D — Deafen toggle (not in input)
 *
 * Singleton — called once in AppLayout.
 * Uses document-level listener for app-wide capture.
 */

import { useEffect } from "react";
import { useUIStore } from "../stores/uiStore";

type KeyboardShortcutActions = {
  toggleMute: () => void;
  toggleDeafen: () => void;
};

export function useKeyboardShortcuts({ toggleMute, toggleDeafen }: KeyboardShortcutActions) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Ctrl+K — Quick Switcher (works in input too)
      if (e.ctrlKey && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        useUIStore.getState().toggleQuickSwitcher();
        return;
      }

      if (isInputFocused) return;

      // Ctrl+Shift+M — Mute toggle
      if (e.ctrlKey && e.shiftKey && e.key === "M") {
        e.preventDefault();
        toggleMute();
        return;
      }

      // Ctrl+Shift+D — Deafen toggle
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        toggleDeafen();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggleMute, toggleDeafen]);
}
