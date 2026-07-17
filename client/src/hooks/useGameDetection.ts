/**
 * useGameDetection — the running game to offer in the voice panel, and how to share it.
 *
 * Detection is Electron-only (game-probe.exe reads Windows GPU counters). Everywhere else this
 * stays null and the row never renders, rather than offering something we cannot deliver.
 */

import { useCallback, useEffect, useState } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import type { DetectedGame } from "../types/electron";

export function useGameDetection(isInVoice: boolean) {
  const [game, setGame] = useState<DetectedGame | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const screenShareMode = useVoiceStore((s) => s.screenShareMode);
  const startNativeSmoothCapture = useVoiceStore((s) => s.startNativeSmoothCapture);
  const setPickedShareSourceId = useVoiceStore((s) => s.setPickedShareSourceId);

  // The probe exists to feed this row, so it lives exactly as long as the row can be on screen.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.startGameDetection || !isInVoice) {
      setGame(null);
      return;
    }

    api.onGameDetected(setGame);
    void api.startGameDetection();

    return () => {
      api.removeGameDetectionListeners?.();
      void api.stopGameDetection?.();
      setGame(null);
    };
  }, [isInVoice]);

  /**
   * Share the detected game. No picker: the row already named the window.
   *
   * Quality follows the user's own persisted choice — the same setting the picker's toggle writes.
   * The row does not invent a third answer to a question they have already answered.
   *
   * The source id is recorded *after* the share is up, and the order is load-bearing. It scopes the
   * share's audio, but VoiceStateManager clears it whenever nothing is being shared — so setting it
   * first, from a row that only exists while nothing is being shared, means it is wiped before the
   * first await returns and the share goes out silent. The picker gets away with the reverse order
   * only because it runs inside getDisplayMedia, by which point isStreaming is already true.
   */
  const shareGame = useCallback(
    async (onFallbackShare: () => void) => {
      if (!game || isStarting) return;
      setIsStarting(true);

      try {
        if (screenShareMode === "smooth") {
          const started = await startNativeSmoothCapture(game.sourceId);
          if (started) {
            setPickedShareSourceId(game.sourceId);
            return;
          }
          // The helper couldn't come up. Fall through to sharp with the same window rather than
          // leaving the user with a button that did nothing.
        }

        await window.electronAPI?.setPrePickedSource?.(game.sourceId);
        onFallbackShare();
        setPickedShareSourceId(game.sourceId);
      } catch (err) {
        console.error("[useGameDetection] share failed:", err);
        // Don't strand a pre-picked source on a later share we never asked for.
        await window.electronAPI?.setPrePickedSource?.(null);
      } finally {
        setIsStarting(false);
      }
    },
    [game, isStarting, screenShareMode, startNativeSmoothCapture, setPickedShareSourceId]
  );

  return { game, isStarting, shareGame };
}
