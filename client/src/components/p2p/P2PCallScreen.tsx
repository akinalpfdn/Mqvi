/**
 * P2PCallScreen — Main P2P call screen.
 *
 * Rendered when tab.type === "p2p" in PanelView.
 *
 * States: ringing (avatar + cancel), active audio (avatar + duration),
 * active video (remote large + local PiP + controls).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useCinemaMode } from "../../hooks/useCinemaMode";
import CinemaButton from "../shared/CinemaButton";
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";
import P2PStreamContextMenu from "./P2PStreamContextMenu";

// ─── Draggable Local PiP ───

function DraggableVideo({ stream, onClick }: { stream: MediaStream; onClick?: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const videoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && stream) node.srcObject = stream;
    },
    [stream],
  );

  // Clamp position within parent bounds
  const clamp = useCallback((el: HTMLDivElement) => {
    const parent = el.parentElement;
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    let x = parseInt(el.style.left || "0", 10);
    let y = parseInt(el.style.top || "0", 10);
    x = Math.max(0, Math.min(x, pr.width - er.width));
    y = Math.max(0, Math.min(y, pr.height - er.height));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(true);

    // Switch from right/bottom positioning to left/top for drag
    const parent = el.parentElement;
    if (parent && !el.style.left) {
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      el.style.left = `${er.left - pr.left}px`;
      el.style.top = `${er.top - pr.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: parseInt(el.style.left || "0", 10),
      origY: parseInt(el.style.top || "0", 10),
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    const ds = dragState.current;
    if (!el || !ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    el.style.left = `${ds.origX + dx}px`;
    el.style.top = `${ds.origY + dy}px`;
    clamp(el);
  }, [clamp]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      setDragging(false);
      dragState.current = null;
      // Tap (no meaningful movement) acts as a click → swap; a real drag does not.
      if (onClick && ds && Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY) < 5) {
        onClick();
      }
    },
    [onClick],
  );

  return (
    <div
      ref={wrapRef}
      className={`p2p-local-video-wrap${dragging ? " dragging" : ""}${onClick ? " swappable" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // Keep PiP interactions from bubbling to the media area's fullscreen dblclick.
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <video ref={videoRef} autoPlay playsInline muted />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function P2PCallScreen() {
  const { t } = useTranslation("common");
  const activeCall = useP2PCallStore((s) => s.activeCall);
  const localStream = useP2PCallStore((s) => s.localStream);
  const remoteStream = useP2PCallStore((s) => s.remoteStream);
  const callDuration = useP2PCallStore((s) => s.callDuration);
  const isVideoOn = useP2PCallStore((s) => s.isVideoOn);
  const remoteVolume = useP2PCallStore((s) => s.remoteVolume);
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Hidden audio element — the single audio sink (every <video> is muted). Also
  // keeps the stream "playing" so the Web Audio source below isn't silent.
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const mediaAreaRef = useRef<HTMLDivElement>(null);
  const isTouch = useIsTouch();
  const { isCinema, enter: enterCinema, exit: exitCinema } = useCinemaMode(mediaAreaRef);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // WhatsApp-style camera swap: which feed fills the big area. Only meaningful
  // when both peers have a camera on; auto-resets otherwise (effect below).
  const [isSwapped, setIsSwapped] = useState(false);

  useEffect(() => {
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // ─── Remote volume ───
  // 0–100% rides the rock-solid <audio>.volume path. Above 100% needs Web Audio
  // amplification (HTMLMediaElement.volume caps at 1.0), engaged only on demand so
  // the default/attenuation path never touches a flaky AudioContext.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);

  const teardownGain = useCallback(() => {
    sourceNodeRef.current?.disconnect();
    gainNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    gainNodeRef.current = null;
    sourceStreamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) ctx.close().catch(() => {});
  }, []);

  useEffect(() => {
    const audioEl = remoteAudioRef.current;
    if (!audioEl) return;

    if (!remoteStream || remoteVolume <= 100) {
      teardownGain();
      audioEl.muted = false;
      audioEl.volume = remoteStream ? Math.max(0, remoteVolume) / 100 : 1;
      return;
    }

    // remoteVolume > 100 — amplify via Web Audio; the <audio> stays muted so the
    // gain graph is the sole output (no doubled audio). On any Web Audio failure,
    // fall back to the unmuted element at full volume so audio is never lost.
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      if (sourceStreamRef.current !== remoteStream) {
        sourceNodeRef.current?.disconnect();
        gainNodeRef.current?.disconnect();
        const source = ctx.createMediaStreamSource(remoteStream);
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);
        sourceNodeRef.current = source;
        gainNodeRef.current = gain;
        sourceStreamRef.current = remoteStream;
      }
      if (gainNodeRef.current) gainNodeRef.current.gain.value = remoteVolume / 100;
      audioEl.muted = true;
      audioEl.volume = 1;
      void ctx.resume();
    } catch (err) {
      console.error("[p2p] Web Audio amplification failed, falling back:", err);
      teardownGain();
      audioEl.muted = false;
      audioEl.volume = 1;
    }
  }, [remoteStream, remoteVolume, teardownGain]);

  // Tear the audio graph down on unmount (tab switch unmounts this screen).
  useEffect(() => () => teardownGain(), [teardownGain]);

  // ─── Fullscreen ───
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === mediaAreaRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    if (!mediaAreaRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err: unknown) => {
        console.error("[p2p] Failed to exit fullscreen:", err);
      });
    } else {
      mediaAreaRef.current.requestFullscreen().catch((err: unknown) => {
        console.error("[p2p] Failed to enter fullscreen:", err);
      });
    }
  }, []);

  const isCaller = activeCall ? activeCall.caller_id === currentUserId : false;
  const otherName = activeCall
    ? (isCaller
        ? (activeCall.receiver_display_name ?? activeCall.receiver_username)
        : (activeCall.caller_display_name ?? activeCall.caller_username))
    : "";
  const otherAvatar = activeCall
    ? (isCaller ? activeCall.receiver_avatar : activeCall.caller_avatar)
    : null;

  const isRinging = activeCall?.status === "ringing";
  const isActive = activeCall?.status === "active";
  const isScreenSharing = useP2PCallStore((s) => s.isScreenSharing);

  const hasRemoteVideo = remoteStream?.getVideoTracks().some((tr) => tr.enabled);
  const hasLocalVideo = localStream?.getVideoTracks().some((tr) => tr.enabled);

  // ─── Camera swap (WhatsApp-style) ───
  // The PiP always shows your own camera as the secondary view; when both peers
  // have a camera, tapping the PiP swaps which feed fills the big area.
  const localHasCam = !!hasLocalVideo && isVideoOn && !isScreenSharing;
  const bothHaveVideo = localHasCam && !!hasRemoteVideo;
  const effectiveSwapped = isSwapped && bothHaveVideo;

  const bigStream = effectiveSwapped ? localStream : remoteStream;
  const bigHasVideo = effectiveSwapped ? true : !!hasRemoteVideo;
  const pipStream = effectiveSwapped ? remoteStream : localStream;

  // Drop a stale swap when the pair is no longer both-on-camera.
  useEffect(() => {
    if (!bothHaveVideo && isSwapped) setIsSwapped(false);
  }, [bothHaveVideo, isSwapped]);

  const handlePipClick = useCallback(() => {
    if (bothHaveVideo) setIsSwapped((s) => !s);
  }, [bothHaveVideo]);

  // The big feed's srcObject follows whichever stream is foregrounded (muted —
  // audio always comes from the hidden <audio> element).
  const bigVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && bigStream) node.srcObject = bigStream;
    },
    [bigStream],
  );

  // Double-click toggles fullscreen on the foreground stream.
  const handleDoubleClick = useCallback(() => {
    if (!bigHasVideo) return;
    handleFullscreenToggle();
  }, [bigHasVideo, handleFullscreenToggle]);

  // Suppress the native media menu on the video and open ours instead. Without
  // preventDefault a fullscreen <video> shows the browser menu (Save as…, PiP…).
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!bigHasVideo) return;
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [bigHasVideo]
  );

  // Single return to keep hidden <audio> always in DOM
  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {!activeCall ? (
        <div className="p2p-call-screen p2p-empty">
          <span className="p2p-status-text">{t("callEnded")}</span>
        </div>
      ) : isRinging ? (
        <div className="p2p-call-screen p2p-ringing">
          <div className="p2p-avatar-large">
            <Avatar
              name={otherName}
              avatarUrl={otherAvatar ?? undefined}
              size={120}
              isCircle
            />
            <div className="p2p-ring-anim" />
          </div>
          <span className="p2p-status-text">
            {t("callingUser", { username: otherName })}
          </span>
          <P2PCallControls minimal />
        </div>
      ) : isActive ? (
        <div className="p2p-call-screen p2p-active">
          <div
            ref={mediaAreaRef}
            className={`p2p-media-area${isCinema ? " cinema" : ""}`}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
          >
            {bigHasVideo ? (
              <video
                ref={bigVideoRef}
                className="p2p-remote-video"
                autoPlay
                playsInline
                muted
              />
            ) : (
              <div className="p2p-avatar-large">
                <Avatar
                  name={otherName}
                  avatarUrl={otherAvatar ?? undefined}
                  size={120}
                  isCircle
                />
              </div>
            )}

            {/* Floating PiP — your own camera; tap to swap when both are on camera */}
            {localHasCam && pipStream && (
              <DraggableVideo
                stream={pipStream}
                onClick={bothHaveVideo ? handlePipClick : undefined}
              />
            )}

            {/* Hover overlay — fullscreen + cinema, stacked. A flex column, not two boxes with
                offsets picked to miss each other: the gap is the browser's problem, and it
                cannot get it wrong on a device we have never seen. */}
            {bigHasVideo && (
              <div className="p2p-stream-overlay">
                <div className="media-controls">
                <button
                  type="button"
                  onClick={handleFullscreenToggle}
                  className="p2p-stream-btn"
                  title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
                >
                  {isFullscreen ? (
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                    </svg>
                  ) : (
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                  )}
                </button>

                {isTouch && (
                  <CinemaButton isCinema={isCinema} onEnter={enterCinema} onExit={exitCinema} />
                )}
                </div>
              </div>
            )}

            {ctxMenu && (
              <P2PStreamContextMenu
                displayName={otherName}
                position={ctxMenu}
                onClose={() => setCtxMenu(null)}
              />
            )}
          </div>

          <div className="p2p-duration">{formatDuration(callDuration)}</div>
          <P2PCallControls />
        </div>
      ) : null}
    </>
  );
}

export default P2PCallScreen;
