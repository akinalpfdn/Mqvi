/**
 * useSystemAudioCapture — Process-exclusive system audio capture hook.
 *
 * Uses the native audio-capture.exe (WASAPI process loopback) to capture
 * system audio while excluding our own Electron process tree. This prevents
 * the screen share echo problem where remote participants hear their own voice.
 *
 * Audio pipeline:
 *   1. audio-capture.exe captures system audio (excluding Electron PID)
 *   2. Raw PCM data flows via IPC: native → main process → renderer
 *   3. This hook receives PCM data and feeds it to an AudioWorklet
 *   4. AudioWorklet → AudioContext.createMediaStreamDestination()
 *   5. The resulting MediaStreamTrack is returned for LiveKit to publish
 *
 * Usage in VoiceStateManager:
 *   const { start, stop, audioTrack } = useSystemAudioCapture();
 *   // When screen share starts with audio:
 *   await start();
 *   if (audioTrack) localParticipant.publishTrack(audioTrack, ...);
 *   // When screen share stops:
 *   stop();
 *
 * This hook is only active in Electron (isElectron() === true).
 * In browser mode, screen share audio uses getDisplayMedia's built-in audio.
 */

import { useState, useRef, useCallback } from "react";
import { isElectron } from "../utils/constants";

/** Return type of useSystemAudioCapture hook */
interface SystemAudioCapture {
  /** Start the native audio capture process */
  start: () => Promise<MediaStreamTrack | null>;
  /** Stop capture and clean up resources */
  stop: () => void;
  /** Whether capture is currently active */
  isCapturing: boolean;
}

export function useSystemAudioCapture(): SystemAudioCapture {
  const [isCapturing, setIsCapturing] = useState(false);

  // Refs for cleanup — AudioContext and worklet node must persist across renders
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);

  const start = useCallback(async (): Promise<MediaStreamTrack | null> => {
    if (!isElectron()) return null;

    const api = window.electronAPI;
    if (!api) return null;

    return new Promise<MediaStreamTrack | null>((resolve) => {
      let resolved = false;

      // Remove ALL previous capture listeners before registering new ones.
      // Without this, ipcRenderer.on() accumulates duplicate listeners
      // across screen share sessions. Old listeners from previous sessions
      // intercept events meant for the current session, causing:
      // - Stale "capture-audio-stopped" events resolving new promises as null
      // - Old data listeners posting to disconnected worklet nodes
      api.removeCaptureListeners();

      // Forward main process errors/debug to renderer console
      api.onCaptureAudioError((msg: string) => {
        console.error("[useSystemAudioCapture] Main process:", msg);
      });

      // Listen for audio header (format info) from native capture
      api.onCaptureAudioHeader(async (header) => {
        if (resolved) return;

        try {
          // Create AudioContext matching the capture format
          const ctx = new AudioContext({ sampleRate: header.sampleRate });
          audioCtxRef.current = ctx;

          // Load the PCM feeder worklet processor.
          // URL must be relative — absolute "/" resolves to filesystem root
          // with file:// protocol (production), breaking asar loading.
          const moduleUrl = new URL(
            "pcm-feeder-processor.js",
            window.location.href
          ).href;
          await ctx.audioWorklet.addModule(moduleUrl);

          // Create worklet node with matching channel count
          const workletNode = new AudioWorkletNode(ctx, "pcm-feeder", {
            outputChannelCount: [header.channels],
            processorOptions: { channelCount: header.channels },
          });
          workletNodeRef.current = workletNode;

          // Create MediaStream destination — this gives us a MediaStreamTrack
          const dest = ctx.createMediaStreamDestination();
          destRef.current = dest;

          // Connect: worklet → destination
          workletNode.connect(dest);

          // The audio track that LiveKit will publish
          const track = dest.stream.getAudioTracks()[0];
          trackRef.current = track;

          // Now listen for PCM data and feed to worklet
          const isFloat = header.formatTag === 3;
          const bytesPerSample = header.bitsPerSample / 8;

          api.onCaptureAudioData((data: Uint8Array) => {
            // Convert raw bytes to Float32Array for the worklet
            let float32Data: Float32Array;

            if (isFloat && bytesPerSample === 4) {
              // Already float32 — just reinterpret
              float32Data = new Float32Array(
                data.buffer,
                data.byteOffset,
                Math.floor(data.byteLength / 4)
              );
            } else if (bytesPerSample === 2) {
              // 16-bit PCM int → float32
              const int16 = new Int16Array(
                data.buffer,
                data.byteOffset,
                Math.floor(data.byteLength / 2)
              );
              float32Data = new Float32Array(int16.length);
              for (let i = 0; i < int16.length; i++) {
                float32Data[i] = int16[i] / 32768;
              }
            } else {
              // Unsupported format — skip
              return;
            }

            // Send to worklet's ring buffer via port
            workletNode.port.postMessage(float32Data);
          });

          setIsCapturing(true);
          resolved = true;
          resolve(track);
        } catch (err) {
          console.error("[useSystemAudioCapture] Setup failed:", err);
          resolved = true;
          resolve(null);
        }
      });

      // Handle capture stop before header arrives
      api.onCaptureAudioStopped(() => {
        console.error("[useSystemAudioCapture] Capture stopped (exe exited before header)");
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      // Tell main process to start the native capture
      api.startSystemCapture().catch((err: unknown) => {
        console.error("[useSystemAudioCapture] Start failed:", err);
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      // Timeout: if header doesn't arrive in 5 seconds, give up
      setTimeout(() => {
        if (!resolved) {
          console.error("[useSystemAudioCapture] Timeout waiting for header");
          resolved = true;
          resolve(null);
        }
      }, 5000);
    });
  }, []);

  const stop = useCallback(() => {
    if (!isElectron()) return;

    const api = window.electronAPI;
    if (!api) return;

    // Remove IPC listeners first — prevents stale exit events from
    // the killed process from interfering with future sessions
    api.removeCaptureListeners();

    // Stop the native capture process
    api.stopSystemCapture().catch(() => {
      // Ignore errors during cleanup
    });

    // Stop the MediaStreamTrack
    if (trackRef.current) {
      trackRef.current.stop();
      trackRef.current = null;
    }

    // Disconnect and close AudioContext
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (destRef.current) {
      destRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    setIsCapturing(false);
  }, []);

  return { start, stop, isCapturing };
}
