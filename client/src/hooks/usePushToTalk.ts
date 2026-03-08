/**
 * usePushToTalk — Push-to-talk key listener.
 *
 * Document-level keydown/keyup listeners for app-wide PTT.
 *
 * Guards:
 * - Focus guard: disabled when typing in input/textarea/contentEditable
 * - Repeat filter: ignores e.repeat (browser auto-repeat on key hold)
 * - Mode guard: no-op if inputMode !== "push_to_talk"
 * - Connection guard: no-op if not in a voice channel
 * - Blur guard: releases mic on window blur (alt-tab)
 */

import { useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";

type UsePushToTalkParams = {
  setMicEnabled: (enabled: boolean) => void;
};

export function usePushToTalk({ setMicEnabled }: UsePushToTalkParams): void {
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  // Ref — no re-render needed, side-effect only
  const isPressedRef = useRef(false);

  useEffect(() => {
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
