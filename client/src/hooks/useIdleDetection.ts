/**
 * useIdleDetection — User inactivity detection hook.
 *
 * Listens for DOM activity events (mouse, keyboard, etc.).
 * After IDLE_TIMEOUT (5min) of inactivity, sends "idle" status.
 * Resumes to "online" on activity.
 *
 * Skipped when manualStatus is not "online" (DND, Idle, Invisible).
 * Skipped when user is in a voice channel.
 *
 * Singleton — called once in AppLayout.
 */

import { useEffect, useRef } from "react";
import { IDLE_TIMEOUT, ACTIVITY_EVENTS } from "../utils/constants";
import { useAuthStore } from "../stores/authStore";
import { useVoiceStore } from "../stores/voiceStore";
import type { UserStatus } from "../types";

type UseIdleDetectionParams = {
  sendPresenceUpdate: (status: UserStatus, isAuto?: boolean) => void;
};

export function useIdleDetection({ sendPresenceUpdate }: UseIdleDetectionParams) {
  /** useRef instead of useState — only read in event handlers, no re-render needed */
  const isIdleRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function resetTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Skip auto idle/online transitions if manual status is set
      const manual = useAuthStore.getState().manualStatus;
      if (manual !== "online") {
        return;
      }

      // Activity detected while idle — return to online (auto, not persisted)
      if (isIdleRef.current) {
        isIdleRef.current = false;
        sendPresenceUpdate("online", true);
      }

      timerRef.current = setTimeout(function idleCheck() {
        const currentManual = useAuthStore.getState().manualStatus;
        if (currentManual !== "online") {
          return;
        }

        // Don't go idle while in a voice channel — restart timer instead
        const inVoice = useVoiceStore.getState().currentVoiceChannelId !== null;
        if (inVoice) {
          timerRef.current = setTimeout(idleCheck, IDLE_TIMEOUT);
          return;
        }

        isIdleRef.current = true;
        sendPresenceUpdate("idle", true);
      }, IDLE_TIMEOUT);
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    resetTimer();

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [sendPresenceUpdate]);
}
