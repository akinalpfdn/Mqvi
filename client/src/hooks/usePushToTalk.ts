/**
 * usePushToTalk — Push-to-talk key listener.
 *
 * Two modes depending on runtime:
 *
 * Electron: Registers a global shortcut via uIOhook (native keyboard hook)
 * so PTT works even when the app window is not focused (e.g. in a game).
 * Falls back to document listeners when the window IS focused to avoid
 * double-firing and to respect the text input guard.
 *
 * Browser: Document-level keydown/keyup listeners (only works when focused).
 *
 * Guards (browser path):
 * - Focus guard: disabled when typing in input/textarea/contentEditable
 * - Repeat filter: ignores e.repeat (browser auto-repeat on key hold)
 * - Mode guard: no-op if inputMode !== "push_to_talk"
 * - Connection guard: no-op if not in a voice channel
 * - Blur guard: releases mic on window blur (alt-tab)
 */

import { useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { isElectron } from "../utils/constants";

type UsePushToTalkParams = {
  setMicEnabled: (enabled: boolean) => void;
};

export function usePushToTalk({ setMicEnabled }: UsePushToTalkParams): void {
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  // Ref — no re-render needed, side-effect only
  const isPressedRef = useRef(false);

  // ─── Electron: global PTT via uIOhook IPC ───
  useEffect(() => {
    if (!isElectron()) return;
    if (inputMode !== "push_to_talk" || !currentVoiceChannelId) return;

    const api = window.electronAPI!;

    // Remove stale listeners from previous sessions
    api.removePTTListeners();

    api.onPTTGlobalDown(() => {
      if (isPressedRef.current) return;
      const { isMuted, isServerMuted } = useVoiceStore.getState();
      if (isMuted || isServerMuted) return;
      isPressedRef.current = true;
      setMicEnabled(true);
    });

    api.onPTTGlobalUp(() => {
      if (!isPressedRef.current) return;
      isPressedRef.current = false;
      setMicEnabled(false);
    });

    // Register the key with the main process
    api.registerPTTShortcut(pttKey);

    return () => {
      api.unregisterPTTShortcut();
      api.removePTTListeners();

      if (isPressedRef.current) {
        isPressedRef.current = false;
        setMicEnabled(false);
      }
    };
  }, [inputMode, pttKey, currentVoiceChannelId, setMicEnabled]);

  // ─── Browser: document-level keydown/keyup (focus required) ───
  useEffect(() => {
    // Skip in Electron — global hook handles everything
    if (isElectron()) return;
    if (inputMode !== "push_to_talk" || !currentVoiceChannelId) return;

    function isTextInput(el: Element | null): boolean {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.code !== pttKey) return;
      if (isTextInput(document.activeElement)) return;
      if (isPressedRef.current) return;
      const { isMuted, isServerMuted } = useVoiceStore.getState();
      if (isMuted || isServerMuted) return;

      isPressedRef.current = true;
      setMicEnabled(true);
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== pttKey) return;
      if (!isPressedRef.current) return;

      isPressedRef.current = false;
      setMicEnabled(false);
    }

    // Release mic on window blur (e.g. alt-tab)
    function handleBlur() {
      if (isPressedRef.current) {
        isPressedRef.current = false;
        setMicEnabled(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);

      // Ensure mic is off when exiting PTT mode
      if (isPressedRef.current) {
        isPressedRef.current = false;
        setMicEnabled(false);
      }
    };
  }, [inputMode, pttKey, currentVoiceChannelId, setMicEnabled]);
}
