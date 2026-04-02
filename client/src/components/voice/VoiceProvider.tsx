/**
 * VoiceProvider — Keeps LiveKit connection persistent at AppLayout level.
 *
 * LiveKitRoom lives here so tab switches don't unmount the WebRTC connection.
 * Visual components (VoiceParticipantGrid, ScreenShareView) can mount/unmount
 * freely — the LiveKit context stays alive in the parent.
 *
 * `display:contents` makes the wrapper div invisible to CSS layout.
 * `connect` prop controls connection: false = Room created but not connected.
 *
 * Always-mounted children:
 * - RoomAudioRenderer: keeps remote audio playing across tab switches
 * - VoiceStateManager: syncs store <-> LiveKit state (mute/deafen/PTT/volume)
 *
 * E2EE: Server generates a random passphrase per voice room.
 * ExternalE2EEKeyProvider.setKey(passphrase) activates SFrame encryption
 * via LiveKit's built-in e2ee-worker.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { DisconnectReason, ExternalE2EEKeyProvider, LogLevel, setLogLevel, VideoPreset } from "livekit-client";
import type { AudioCaptureOptions, RoomOptions } from "livekit-client";

// Suppress noisy SDK logs (transition disconnects, internal WS lifecycle).
// Only real errors will appear in the console.
setLogLevel(LogLevel.error);
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import VoiceStateManager from "./VoiceStateManager";

type VoiceProviderProps = {
  children: React.ReactNode;
};

function VoiceProvider({ children }: VoiceProviderProps) {
  const { t } = useTranslation("voice");
  const { t: tE2ee } = useTranslation("e2ee");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const e2eePassphrase = useVoiceStore((s) => s.e2eePassphrase);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const inputDevice = useVoiceStore((s) => s.inputDevice);

  const isConnected = !!livekitUrl && !!livekitToken;

  // ─── E2EE Key Provider ───

  // Stable singleton — LiveKit uses PBKDF2 to derive a CryptoKey from passphrase
  const keyProvider = useMemo(() => new ExternalE2EEKeyProvider(), []);

  // SFrame worker runs off main thread. Created/terminated on passphrase toggle.
  // useMemo (not useRef+useEffect) so roomOptions can reference it in the same render pass.
  const e2eeWorker = useMemo(() => {
    if (e2eePassphrase) {
      return new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url)
      );
    }
    return null;
  }, [!!e2eePassphrase]);

  // Terminate previous worker on passphrase change or unmount
  useEffect(() => {
    return () => {
      e2eeWorker?.terminate();
    };
  }, [e2eeWorker]);

  // Set key when passphrase changes (async PBKDF2 derivation)
  useEffect(() => {
    if (e2eePassphrase) {
      keyProvider.setKey(e2eePassphrase).catch((err: unknown) => {
        console.error("[VoiceProvider] Failed to set E2EE key:", err);
        useToastStore.getState().addToast("error", tE2ee("voiceE2eeError"), 8000);
      });
    }
  }, [e2eePassphrase, keyProvider, tE2ee]);

  // Track rejoin attempts to prevent infinite loops
  const rejoinAttemptsRef = useRef(0);
  const MAX_REJOIN_ATTEMPTS = 2;

  // Reset rejoin counter when user explicitly joins a DIFFERENT channel.
  // Only track non-null channels so auto-rejoin (leave→rejoin same channel)
  // doesn't reset the counter.
  const prevChannelRef = useRef<string | null>(null);
  useEffect(() => {
    const channelId = useVoiceStore.getState().currentVoiceChannelId;
    if (channelId && channelId !== prevChannelRef.current) {
      rejoinAttemptsRef.current = 0;
    }
    // Only update ref for non-null channels to avoid null→same-channel reset
    if (channelId) {
      prevChannelRef.current = channelId;
    }
  });

  /**
   * onDisconnected — handles LiveKit disconnect events.
   *
   * CLIENT_INITIATED fires both on real disconnect AND on connect prop transitions
   * (connect=false -> connect=true). We distinguish them by checking if the store
   * still has an active voice channel — if so, it's a transition disconnect (ignore).
   *
   * For server-initiated disconnects (network blip, token expiry), attempt auto-rejoin
   * with a fresh LiveKit token instead of fully leaving.
   */
  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const { currentVoiceChannelId, _wsSend, wasReplaced } = useVoiceStore.getState();

      // Another session took over voice — don't auto-rejoin (prevents ping-pong loop)
      if (wasReplaced) {
        useVoiceStore.setState({ wasReplaced: false });
        return;
      }

      if (reason === DisconnectReason.CLIENT_INITIATED) {
        if (currentVoiceChannelId) return; // Transition disconnect — ignore
      }

      // Server-initiated disconnect while user was in voice — attempt auto-rejoin
      if (currentVoiceChannelId && reason !== DisconnectReason.CLIENT_INITIATED) {
        if (rejoinAttemptsRef.current < MAX_REJOIN_ATTEMPTS) {
          rejoinAttemptsRef.current++;
          const channelToRejoin = currentVoiceChannelId;

          // Preserve mute/deafen state across auto-rejoin
          const { isMuted: prevMuted, isDeafened: prevDeafened } = useVoiceStore.getState();

          leaveVoiceChannel();
          useVoiceStore.getState().joinVoiceChannel(channelToRejoin).then((tokenResp) => {
            if (tokenResp && _wsSend) {
              useVoiceStore.setState({ isMuted: prevMuted, isDeafened: prevDeafened });
              _wsSend("voice_join", { channel_id: channelToRejoin });
            } else {
              console.warn("[VoiceProvider] Auto-rejoin failed");
            }
          });
          return;
        }

        console.warn("[VoiceProvider] Max rejoin attempts reached, giving up");
      }

      leaveVoiceChannel();
    },
    [leaveVoiceChannel]
  );

  // Filter out expected "Client initiated" errors during connect prop transitions
  const handleError = useCallback(
    (err: Error) => {
      if (err.message?.includes("Client initiated")) return;

      console.error("[VoiceProvider] LiveKit error:", err);
      useToastStore.getState().addToast(
        "error",
        t("livekitConnectionError"),
        8000
      );
    },
    [t]
  );

  // SFrame E2EE error (passphrase mismatch, worker failure, etc.)
  const handleEncryptionError = useCallback(
    (err: Error) => {
      console.error("[VoiceProvider] E2EE encryption error:", err);
      useToastStore.getState().addToast(
        "error",
        tE2ee("voiceE2eeError"),
        8000
      );
    },
    [tE2ee]
  );

  // Stable ref — LiveKitRoom does reference comparison on props
  const audioCaptureDefaults: AudioCaptureOptions = useMemo(
    () => ({
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: true,
      ...(inputDevice ? { deviceId: inputDevice } : {}),
    }),
    [inputDevice]
  );

  /**
   * Screen share publish defaults:
   * - 1080p/30fps main layer, 3 Mbps
   * - Simulcast: 720p/30fps (1.5M), 720p/15fps (800K) for bandwidth adaptation
   * - VP9: ~30-40% better compression than H264 at same bitrate
   */
  const publishDefaults = useMemo(
    () => ({
      screenShareEncoding: {
        maxBitrate: 3_000_000,
        maxFramerate: 30,
      },
      screenShareSimulcastLayers: [
        new VideoPreset(1280, 720, 1_500_000, 30),
        new VideoPreset(1280, 720, 800_000, 15),
      ],
      videoCodec: "vp9" as const,
    }),
    []
  );

  // Attach E2EE config when passphrase + worker are available
  const roomOptions: RoomOptions | undefined = useMemo(() => {
    if (!isConnected) return undefined;

    const base: RoomOptions = {
      audioCaptureDefaults,
      publishDefaults,
      webAudioMix: true,
    };

    if (e2eePassphrase && e2eeWorker) {
      base.e2ee = {
        keyProvider,
        worker: e2eeWorker,
      };
    }

    return base;
  }, [isConnected, audioCaptureDefaults, publishDefaults, e2eePassphrase, keyProvider, e2eeWorker]);

  // LiveKitRoom always rendered — connect prop toggles connection.
  // display:contents makes wrapper invisible to flex/grid layout.
  return (
    <LiveKitRoom
      serverUrl={livekitUrl || "wss://placeholder.invalid"}
      token={livekitToken || ""}
      connect={isConnected}
      audio={false}
      video={false}
      options={roomOptions}
      onDisconnected={handleDisconnected}
      onError={handleError}
      onEncryptionError={handleEncryptionError}
      style={{ display: "contents" }}
    >
      {isConnected && <RoomAudioRenderer />}
      {isConnected && <VoiceStateManager />}
      {children}
    </LiveKitRoom>
  );
}

export default VoiceProvider;
