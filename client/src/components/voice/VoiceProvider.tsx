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

setLogLevel(LogLevel.warn);
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import { useNativeVoice, nativeVoiceConnect, onNativeVoiceActiveSpeakers, onNativeVoiceDisconnected } from "../../utils/nativePlugins";
import VoiceStateManager from "./VoiceStateManager";
import NativeVoiceStateSync from "./NativeVoiceStateSync";

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

  const isInVoice = !!livekitUrl && !!livekitToken;

  // iOS: native SDK handles voice connection — don't connect JS SDK.
  // JS LiveKitRoom stays mounted (for context) but with connect=false.
  const isNativeVoice = useNativeVoice();
  const isConnected = isInVoice && !isNativeVoice;

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
      // iOS native voice: JS SDK isn't used — ignore all JS disconnect events
      if (isNativeVoice) return;

      const { currentVoiceChannelId, _wsSend, wasReplaced } = useVoiceStore.getState();

      // Another session took over voice — don't auto-rejoin (prevents ping-pong loop)
      if (wasReplaced) {
        useVoiceStore.setState({ wasReplaced: false });
        return;
      }

      if (reason === DisconnectReason.CLIENT_INITIATED) {
        // Client-initiated disconnect means our own code triggered it (explicit
        // leave, force-move token swap, auto-rejoin, admin/AFK kick handler).
        // Every caller clears state before firing — a second cleanup here bumps
        // _joinGeneration and races any in-flight join (force-move repro).
        return;
      }

      // DUPLICATE_IDENTITY: SFU saw a second connection with our identity. Almost
      // always the SDK's own full reconnect (signal WS dropped → resume failed →
      // SDK opens new connection → SFU evicts the old one). True multi-device
      // replacement is handled by wasReplaced above. Treat as server-initiated
      // and auto-rejoin via the path below.

      // Server-initiated or SDK-internal disconnect while user was in voice.
      if (currentVoiceChannelId) {
        if (rejoinAttemptsRef.current < MAX_REJOIN_ATTEMPTS) {
          rejoinAttemptsRef.current++;
          const channelToRejoin = currentVoiceChannelId;

          // Hot-swap token — keeps connect=true the whole time.
          // leaveVoiceChannel+joinVoiceChannel caused connect=false→true thrash
          // which made LiveKitRoom create 2 Room instances, each triggering
          // DUPLICATE_IDENTITY on the SFU and consuming rejoin attempts.
          useVoiceStore.getState().refreshVoiceToken(channelToRejoin).then((tokenResp) => {
            if (tokenResp && _wsSend) {
              _wsSend("voice_join", { channel_id: channelToRejoin });
            } else {
              // Rejoin token fetch failed — we're dropping the user for real.
              useToastStore.getState().addToast("error", t("youWereDisconnected"), 6000);
              leaveVoiceChannel();
            }
          });
          return;
        }
      }

      // Unrecoverable drop (rejoin exhausted) — notify only if they were in voice.
      if (currentVoiceChannelId) {
        useToastStore.getState().addToast("error", t("youWereDisconnected"), 6000);
      }
      leaveVoiceChannel();
    },
    [leaveVoiceChannel, t]
  );

  /**
   * iOS native voice counterpart of handleDisconnected. The native SDK reports a
   * drop only after its own reconnects are exhausted or the server removed us.
   * Same rejoin policy, but the reconnect is an explicit native connect with the
   * refreshed token because the JS LiveKitRoom is never connected on iOS.
   */
  const handleNativeDisconnected = useCallback(
    (error: string) => {
      // The room that reported them is gone; a rejoin reports afresh.
      useVoiceStore.getState().setActiveSpeakers([]);
      const { currentVoiceChannelId, _wsSend, wasReplaced } = useVoiceStore.getState();

      if (wasReplaced) {
        useVoiceStore.setState({ wasReplaced: false });
        return;
      }

      // Store already left (explicit leave raced the native callback).
      if (!currentVoiceChannelId) return;

      if (rejoinAttemptsRef.current < MAX_REJOIN_ATTEMPTS) {
        rejoinAttemptsRef.current++;
        const channelToRejoin = currentVoiceChannelId;

        useVoiceStore
          .getState()
          .refreshVoiceToken(channelToRejoin)
          .then(async (tokenResp) => {
            if (!tokenResp || !_wsSend) return false;
            const { isMuted, isDeafened } = useVoiceStore.getState();
            const connected = await nativeVoiceConnect(tokenResp.url, tokenResp.token, isMuted, isDeafened);
            if (!connected) return false;
            _wsSend("voice_join", { channel_id: channelToRejoin });
            return true;
          })
          .catch(() => false)
          .then((rejoined) => {
            if (rejoined) return;
            useToastStore.getState().addToast("error", t("youWereDisconnected"), 6000);
            leaveVoiceChannel();
          });
        return;
      }

      console.error("[VoiceProvider] native voice dropped:", error);
      useToastStore.getState().addToast("error", t("youWereDisconnected"), 6000);
      leaveVoiceChannel();
    },
    [leaveVoiceChannel, t]
  );

  useEffect(() => {
    if (!isNativeVoice || !isInVoice) return;
    const disposers: (() => void)[] = [];
    let cancelled = false;
    const keep = (dispose: () => void) => {
      if (cancelled) dispose();
      else disposers.push(dispose);
    };
    void onNativeVoiceDisconnected(handleNativeDisconnected).then(keep);
    // Who is talking: everywhere else the JS room reports it, and on iOS that room never connects.
    void onNativeVoiceActiveSpeakers(useVoiceStore.getState().setActiveSpeakers).then(keep);
    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [isNativeVoice, isInVoice, handleNativeDisconnected]);

  const handleError = useCallback(
    (err: Error) => {
      console.error("[VoiceProvider] LiveKit error:", err);

      // Connection errors are transient failed (re)connect attempts — the SDK's
      // reconnection and handleDisconnected's auto-rejoin recover them. Toasting
      // each one spammed the user mid-session while audio kept working. A single
      // terminal toast is shown from handleDisconnected only when recovery fails.
      const isConnectionError =
        err.name === "ConnectionError" ||
        /could not establish|client initiated/i.test(err.message ?? "");
      if (isConnectionError) return;

      useToastStore.getState().addToast("error", t("livekitConnectionError"), 8000);
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
      channelCount: 1,
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: true,
      ...(inputDevice ? { deviceId: inputDevice } : {}),
    }),
    [inputDevice]
  );

  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);

  /** Screen share publish defaults — adapts to quality setting. */
  const publishDefaults = useMemo(
    () => {
      const is720 = screenShareQuality === "720p";
      return {
        screenShareEncoding: {
          maxBitrate: is720 ? 1_500_000 : 3_000_000,
          maxFramerate: 30,
        },
        screenShareSimulcastLayers: is720
          ? [new VideoPreset(1280, 720, 800_000, 15)]
          : [
              new VideoPreset(1280, 720, 1_500_000, 30),
              new VideoPreset(1280, 720, 800_000, 15),
            ],
        videoCodec: "vp9" as const,
      };
    },
    [screenShareQuality]
  );

  // Attach E2EE config when passphrase + worker are available
  const roomOptions: RoomOptions | undefined = useMemo(() => {
    if (!isConnected) return undefined;

    const base: RoomOptions = {
      audioCaptureDefaults,
      publishDefaults,
      webAudioMix: true,
      // adaptiveStream: SFU sends lower quality layer when subscriber viewport is small.
      // Without this, full-res is sent regardless of viewer size → bandwidth waste → packet loss.
      adaptiveStream: true,
      // dynacast: Pauses video encoding when no subscriber is watching a track.
      // Saves upstream bandwidth when e.g. screen share has 0 viewers.
      dynacast: true,
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
      // Subscriptions are managed explicitly in VoiceStateManager.
      connectOptions={{ autoSubscribe: false }}
      onDisconnected={handleDisconnected}
      onError={handleError}
      onEncryptionError={handleEncryptionError}
      style={{ display: "contents" }}
    >
      {isConnected && !isNativeVoice && <RoomAudioRenderer />}
      {isConnected && !isNativeVoice && <VoiceStateManager />}
      {isInVoice && isNativeVoice && <NativeVoiceStateSync />}
      {children}
    </LiveKitRoom>
  );
}

export default VoiceProvider;
