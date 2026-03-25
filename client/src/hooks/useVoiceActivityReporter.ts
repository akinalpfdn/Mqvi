/**
 * useVoiceActivityReporter — Reports user activity to server while in voice.
 *
 * Sends a debounced "voice_activity" WS ping when the user is in a voice channel
 * and any of these activity types occur:
 * - Mouse/keyboard input
 * - VAD (voice activity detection — user is speaking)
 * - Screen share active (streaming or watching)
 *
 * Max one ping per REPORT_INTERVAL (30s) to avoid flooding.
 * The server uses this to track AFK timeout per user.
 *
 * Singleton — called once in AppLayout.
 */

import { useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { ACTIVITY_EVENTS } from "../utils/constants";

const REPORT_INTERVAL = 30_000; // 30 seconds — matches server AFK check interval

type UseVoiceActivityReporterParams = {
  sendWS: (op: string, data?: unknown) => void;
};

export function useVoiceActivityReporter({ sendWS }: UseVoiceActivityReporterParams) {
  const lastReportRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
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

    // Periodic check for VAD and screen share (no DOM events for these)
    // Runs every 30s — if user is speaking or streaming, report activity
    intervalRef.current = setInterval(() => {
      const store = useVoiceStore.getState();
      if (!store.currentVoiceChannelId) return;

      const isSpeaking = Object.keys(store.activeSpeakers).length > 0;
      const isStreaming = store.isStreaming;
      const isWatchingAny = Object.keys(store.watchingScreenShares).length > 0;

      if (isSpeaking || isStreaming || isWatchingAny) {
        // Force report even if interval hasn't elapsed — these are strong signals
        lastReportRef.current = Date.now();
        sendWS("voice_activity");
      }
    }, REPORT_INTERVAL);

    // Report immediately on voice join
    reportActivity();

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onUserInput);
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [sendWS]);
}
