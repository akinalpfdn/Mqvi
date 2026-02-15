/**
 * useKeyboardShortcuts — Global klavye kısayolları hook'u.
 *
 * Kısayollar:
 * - Ctrl+K — Quick Switcher (kanal arama popup'ı)
 * - Ctrl+Shift+M — Mute toggle (ses kanalındaysa)
 * - Ctrl+Shift+D — Deafen toggle (ses kanalındaysa)
 *
 * Bu hook AppLayout'ta bir kez çağrılır (singleton pattern).
 * Kısayollar sadece input/textarea focus'u yokken çalışır —
 * kullanıcı mesaj yazarken yanlışlıkla tetiklenmesini önler.
 *
 * Neden document-level event listener?
 * Component-level keydown sadece o component focus'tayken çalışır.
 * Global kısayollar her zaman aktif olmalı — document.addEventListener ile
 * tüm tuş vuruşlarını yakalayıp, uygun olanları işliyoruz.
 */

import { useEffect } from "react";
import { useUIStore } from "../stores/uiStore";

type KeyboardShortcutActions = {
  /** Mute toggle — useVoice hook'undan gelen fonksiyon */
  toggleMute: () => void;
  /** Deafen toggle — useVoice hook'undan gelen fonksiyon */
  toggleDeafen: () => void;
};

export function useKeyboardShortcuts({ toggleMute, toggleDeafen }: KeyboardShortcutActions) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Input/textarea alanındaysa kısayolları yoksay.
      // Kullanıcı mesaj yazarken Ctrl+K veya Ctrl+Shift+M yazması
      // input davranışını bozmamalı.
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Ctrl+K — Quick Switcher toggle
      // Input focus'tayken de çalışır (Discord davranışı).
      if (e.ctrlKey && !e.shiftKey && e.key === "k") {
        e.preventDefault();
        useUIStore.getState().toggleQuickSwitcher();
        return;
      }

      // Aşağıdaki kısayollar input focus'tayken çalışmaz
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
