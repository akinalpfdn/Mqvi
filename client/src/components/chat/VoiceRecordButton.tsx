/**
 * VoiceRecordButton — hold-to-record mic button (WhatsApp-style).
 *
 * Hold to record; drag up past a threshold to LOCK (hands-free). Releasing a
 * non-locked hold stages the clip in the composer as a pending attachment — it
 * is NOT sent until the user presses Enter / send (a staged clip is removable
 * via the normal file preview). Uses Pointer Events so mouse + touch (mobile)
 * share one code path.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceRecorder } from "../../hooks/useVoiceRecorder";

type VoiceRecordButtonProps = {
  onRecorded: (file: File) => void;
  disabled?: boolean;
};

const LOCK_THRESHOLD = 60; // px dragged up to lock hands-free
const MIN_MS = 500; // discard accidental taps shorter than this
const MAX_MS = 5 * 60 * 1000; // auto-finish a long/locked recording (5 min)

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VoiceRecordButton({ onRecorded, disabled }: VoiceRecordButtonProps) {
  const { t } = useTranslation("chat");
  const { state, elapsedMs, start, stop, cancel } = useVoiceRecorder();
  const [locked, setLocked] = useState(false);

  const holdingRef = useRef(false);
  const lockedRef = useRef(false);
  const startedRef = useRef(false);
  const pendingStageRef = useRef(false);
  const startYRef = useRef(0);
  const recStartRef = useRef(0);
  const finishingRef = useRef(false);
  /** A hold is in progress, from the press until it is staged or dropped. A ref, not `recording`:
   *  a second press can land before the first one's live state has rendered. */
  const busyRef = useRef(false);
  /** Bumped by each press; a start that resolves for an older press touches nothing. */
  const holdSeqRef = useRef(0);

  const recording = state === "recording";

  const reset = useCallback(() => {
    holdingRef.current = false;
    lockedRef.current = false;
    startedRef.current = false;
    pendingStageRef.current = false;
    finishingRef.current = false;
    busyRef.current = false;
    setLocked(false);
  }, []);

  const finishStage = useCallback(async () => {
    if (finishingRef.current) return; // ignore re-entrant finish (auto-finish tick / double "Done")
    finishingRef.current = true;
    const tooShort = Date.now() - recStartRef.current < MIN_MS;
    const file = await stop();
    reset();
    if (file && !tooShort) onRecorded(file);
  }, [stop, onRecorded, reset]);

  const doCancel = useCallback(() => {
    cancel();
    reset();
  }, [cancel, reset]);

  // Auto-finish (stage) a recording that hits the max duration — prevents a
  // locked-and-forgotten recording from running indefinitely.
  useEffect(() => {
    if (recording && elapsedMs >= MAX_MS) {
      void finishStage();
    }
  }, [recording, elapsedMs, finishStage]);

  /** Removes the window listeners of the hold in progress. */
  const detachHoldRef = useRef<(() => void) | null>(null);

  const detachHold = useCallback(() => {
    detachHoldRef.current?.();
    detachHoldRef.current = null;
  }, []);

  useEffect(() => detachHold, [detachHold]);

  /** The finger lifted: stage the clip, unless the hold was locked. */
  const release = useCallback(() => {
    detachHold();
    if (lockedRef.current) return; // locked — use overlay buttons
    if (!holdingRef.current) return;
    holdingRef.current = false;
    if (!startedRef.current) {
      pendingStageRef.current = true; // start still resolving; stage when it does
      return;
    }
    void finishStage();
  }, [detachHold, finishStage]);

  const abandon = useCallback(() => {
    detachHold();
    if (!lockedRef.current && holdingRef.current) doCancel();
  }, [detachHold, doCancel]);

  const trackLock = useCallback((clientY: number) => {
    if (!holdingRef.current || lockedRef.current) return;
    if (startYRef.current - clientY >= LOCK_THRESHOLD) {
      lockedRef.current = true;
      setLocked(true);
    }
  }, []);

  const onPointerDown = useCallback(
    async (e: React.PointerEvent) => {
      if (disabled || recording || busyRef.current) return;
      e.preventDefault();
      busyRef.current = true;
      const hold = ++holdSeqRef.current;
      startYRef.current = e.clientY;
      holdingRef.current = true;
      lockedRef.current = false;
      pendingStageRef.current = false;
      startedRef.current = false;
      setLocked(false);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — the window listeners below still see the gesture */
      }

      // The hold ends wherever the finger lifts. iOS can hand a long press to another
      // element (or to text selection) mid-hold, and the button would never hear it end.
      detachHold();
      const pointerId = e.pointerId;
      const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && release();
      const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && abandon();
      const onMove = (ev: PointerEvent) => ev.pointerId === pointerId && trackLock(ev.clientY);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("pointermove", onMove, true);
      detachHoldRef.current = () => {
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("pointermove", onMove, true);
      };

      const ok = await start();
      // A newer press owns the refs and listeners now (this one was dropped and the user pressed
      // again); its own start aborted this one.
      if (hold !== holdSeqRef.current) return;
      if (!ok) {
        detachHold();
        reset();
        return;
      }
      startedRef.current = true;
      recStartRef.current = Date.now();
      // Released before the recorder finished starting → stage now (or discard if too short).
      if (pendingStageRef.current) {
        pendingStageRef.current = false;
        void finishStage();
      }
    },
    [disabled, recording, start, reset, finishStage, detachHold, release, abandon, trackLock]
  );

  return (
    <>
      <button
        type="button"
        className="input-action-btn voice-rec-btn"
        title={t("voiceMessageHold")}
        disabled={disabled}
        onPointerDown={onPointerDown}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>

      {recording && (
        <div className={`voice-rec-overlay${locked ? " locked" : ""}`}>
          <span className="voice-rec-dot" />
          <span className="voice-rec-time">{formatElapsed(elapsedMs)}</span>
          {locked ? (
            <div className="voice-rec-actions">
              <button type="button" className="voice-rec-cancel" onClick={doCancel}>
                {t("voiceMessageCancel")}
              </button>
              <button type="button" className="voice-rec-done" onClick={() => void finishStage()}>
                {t("voiceMessageDone")}
              </button>
            </div>
          ) : (
            <>
              <span className="voice-rec-hint">{t("voiceMessageLockHint")}</span>
              {/* Where to slide: sits above the mic, under the thumb's path. */}
              <span className="voice-rec-lock" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 15l6-6 6 6" />
                </svg>
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default VoiceRecordButton;
