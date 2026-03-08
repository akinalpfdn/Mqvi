/**
 * sounds.ts — Synthesized audio effects for voice join/leave, stream watch, and notifications.
 *
 * Uses Web Audio API OscillatorNode — no mp3 files needed.
 *
 * Voice (sine, 200-600Hz):
 *   Join:  Rising 350->600Hz, 0.15s
 *   Leave: Falling 400->200Hz, 0.12s
 *
 * Watch (triangle, 320-620Hz):
 *   Start: Double rising pop 380->500 + 500->620Hz
 *   Stop:  Falling 480->320Hz, 0.1s
 *
 * Notification (sine, 800-1000Hz):
 *   Double pop 800->900 + 900->1000Hz. Skipped in DND/invisible mode.
 *
 * Volume tied to voiceStore.masterVolume. All sounds use GainNode for volume control.
 */

import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";

/** Lazily initialized — created on first sound play, resumed if suspended. */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/** Close AudioContext when leaving voice channel to free memory. */
export function closeAudioContext(): void {
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

/**
 * Plays a short frequency-ramped tone.
 *
 * @param startFreq - Start frequency (Hz)
 * @param endFreq   - End frequency (Hz)
 * @param duration  - Duration (seconds)
 * @param volume    - Volume (0-1)
 * @param waveType  - "sine" (smooth) or "triangle" (slightly digital)
 */
function playTone(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume: number,
  waveType: OscillatorType = "sine"
): void {
  try {
    const ctx = getAudioContext();

    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = waveType;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume * 0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration);

    // Disconnect nodes to prevent memory leak in long sessions
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    // AudioContext not supported or error — silently continue
  }
}

export function playJoinSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(350, 600, 0.15, volume);
}

export function playLeaveSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(400, 200, 0.12, volume);
}

export function playWatchStartSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(380, 500, 0.08, volume, "triangle");
  setTimeout(() => playTone(500, 620, 0.08, volume, "triangle"), 90);
}

export function playWatchStopSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(480, 320, 0.1, volume, "triangle");
}

/** Notification sound — skipped in DND and invisible mode. */
export function playNotificationSound(): void {
  const manualStatus = useAuthStore.getState().manualStatus;
  if (manualStatus === "dnd" || manualStatus === "offline") return;

  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = (masterVolume / 100) * 0.6;
  playTone(800, 900, 0.06, volume);
  setTimeout(() => playTone(900, 1000, 0.06, volume), 70);
}
