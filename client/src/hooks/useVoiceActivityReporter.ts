/**
 * useVoiceActivityReporter — Reports user activity to server while in voice.
 *
 * Sends a debounced "voice_activity" WS ping when the user is in a voice channel
 * and any of these activity types occur:
 * - Mouse/keyboard input in this window
 * - The local user speaking (VAD) — never another participant
 * - Screen share active (streaming or watching)
 * - Desktop: input anywhere on the computer (OS idle time), so someone gaming
 *   in another app with the mic muted is not AFK
 *
 * Max one ping per REPORT_INTERVAL (30s) to avoid flooding.
 * The server uses this to track AFK timeout per user.
 *
 * Singleton — called once in AppLayout.
 */

import { useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import { ACTIVITY_EVENTS } from "../utils/constants";

const REPORT_INTERVAL = 30_000; // 30 seconds — matches server AFK check interval

/** OS input this recent counts: anything since the previous tick. */
const SYSTEM_ACTIVE_WITHIN_SEC = REPORT_INTERVAL / 1000;

type UseVoiceActivityReporterParams = {
  sendWS: (op: string, data?: unknown) => void;
};

function isLocalUserSpeaking(): boolean {
  const myId = useAuthStore.getState().user?.id;
  return !!myId && useVoiceStore.getState().activeSpeakers[myId] === true;
}

/** Desktop only: true when there was input in any app within the last tick. */
async function hadSystemInputRecently(): Promise<boolean> {
  const getIdle = window.electronAPI?.getSystemIdleTime;
  if (!getIdle) return false;
  try {
    return (await getIdle()) < SYSTEM_ACTIVE_WITHIN_SEC;
  } catch {
    return false;
  }
}

export function useVoiceActivityReporter({ sendWS }: UseVoiceActivityReporterParams) {
  const lastReportRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;

    function reportActivity() {
      const inVoice = useVoiceStore.getState().currentVoiceChannelId !== null;
      if (!inVoice) return;

      const now = Date.now();
      if (now - lastReportRef.current < REPORT_INTERVAL) return;

      lastReportRef.current = now;
      sendWS("voice_activity");
    }

    // Mouse/keyboard activity → report
    function onUserInput() {
      reportActivity();
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onUserInput, { passive: true });
    }

    // Speech is an edge, not a state: a tick sampling "speaking right now" would miss someone who
    // talks between ticks.
    const unsubscribeSpeaking = useVoiceStore.subscribe((state, prev) => {
      if (state.activeSpeakers === prev.activeSpeakers) return;
      if (isLocalUserSpeaking()) reportActivity();
    });

    // Periodic check for signals with no DOM events: screen share and, on desktop, OS-wide input.
    intervalRef.current = setInterval(async () => {
      const store = useVoiceStore.getState();
      if (!store.currentVoiceChannelId) return;

      const isStreaming = store.isStreaming;
      const isWatchingAny = Object.keys(store.watchingScreenShares).length > 0;
      const isActive = isStreaming || isWatchingAny || isLocalUserSpeaking() || (await hadSystemInputRecently());
      if (stopped || !isActive) return;

      // Force report even if interval hasn't elapsed — these are strong signals
      lastReportRef.current = Date.now();
      sendWS("voice_activity");
    }, REPORT_INTERVAL);

    // Report immediately on voice join
    reportActivity();

    return () => {
      stopped = true;
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onUserInput);
      }
      unsubscribeSpeaking();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [sendWS]);
}
