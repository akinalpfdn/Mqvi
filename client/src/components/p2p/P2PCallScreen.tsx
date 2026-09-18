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
import { useNativeVideoLayout } from "../../hooks/useNativeVideoLayout";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useCinemaMode } from "../../hooks/useCinemaMode";
import CinemaButton from "../shared/CinemaButton";
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";
import P2PStreamContextMenu from "./P2PStreamContextMenu";

// ─── Draggable Local PiP ───

/** Movement past this is a drag; anything less is a tap, and a tap must not move the box. */
const DRAG_SLOP = 5;

function DraggableVideo({
  stream,
  onClick,
  onElement,
}: {
  /** Null when the picture is drawn natively; the box still positions it. */
  stream: MediaStream | null;
  onClick?: () => void;
  onElement?: (el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // origX/origY stay null until the pointer actually moves: that is the moment the box leaves
  // its corner, and a tap-to-swap must not be that moment.
  const dragState = useRef<{
    startX: number;
    startY: number;
    origX: number | null;
    origY: number | null;
  } | null>(null);

  const videoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      // Assigning null matters as much as assigning a stream: an element left holding the old
      // one keeps showing its last frame after the feed is gone.
      if (node) node.srcObject = stream ?? null;
    },
    [stream],
  );

  // The native layer needs this box's position, and only the parent knows what to do with it.
  useEffect(() => {
    onElement?.(wrapRef.current);
    return () => onElement?.(null);
  }, [onElement]);

  // Clamp into the parent. Skipped while still pinned to a corner, which writing left/top would undo.
  const clamp = useCallback((el: HTMLDivElement) => {
    const parent = el.parentElement;
    if (!parent || !el.style.left) return;
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
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: null, origY: null };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    const ds = dragState.current;
    if (!el || !ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;

    // Leave the corner only on a real drag: a tapped box pinned left grew past the edge on a swap.
    if (ds.origX === null || ds.origY === null) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      const parent = el.parentElement;
      if (!parent) return;
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      el.style.left = `${er.left - pr.left}px`;
      el.style.top = `${er.top - pr.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      ds.origX = parseInt(el.style.left, 10);
      ds.origY = parseInt(el.style.top, 10);
      setDragging(true);
    }

    el.style.left = `${ds.origX + dx}px`;
    el.style.top = `${ds.origY + dy}px`;
    clamp(el);
  }, [clamp]);

  // A swap can widen the box; a dragged one is pulled back inside.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => clamp(el));
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamp]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      setDragging(false);
      dragState.current = null;
      // Tap (no meaningful movement) acts as a click → swap; a real drag does not.
      if (onClick && ds && Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY) < DRAG_SLOP) {
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
  const isNativeVideo = useP2PCallStore((s) => s.isNativeVideo);
  const hasRemoteVideo = useP2PCallStore((s) => s.hasRemoteVideo);
  const cameraFacing = useP2PCallStore((s) => s.cameraFacing);
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Boxes the native layer draws into. Refs as state: the hook has to re-run when they arrive.
  const [bigEl, setBigEl] = useState<HTMLElement | null>(null);
  const [pipEl, setPipEl] = useState<HTMLElement | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLElement | null>(null);

  // Remote audio is rendered by P2PAudioSink at app level (survives tab switches); this screen
  // is visuals only. Every <video> here stays muted.
  const mediaAreaRef = useRef<HTMLDivElement>(null);
  const attachMediaArea = useCallback((el: HTMLDivElement | null) => {
    mediaAreaRef.current = el;
    setMediaEl(el);
  }, []);
  const isTouch = useIsTouch();
  const { isCinema, enter: enterCinema, exit: exitCinema } = useCinemaMode(mediaAreaRef);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // WhatsApp-style camera swap: which feed fills the big area. Only meaningful
  // when both peers have a camera on; auto-resets otherwise (effect below).
  const [isSwapped, setIsSwapped] = useState(false);

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

  // The peer's picture always comes from the store: a remote track's `enabled` is our setting.
  const hasLocalVideo = isNativeVideo
    ? isVideoOn
    : localStream?.getVideoTracks().some((tr) => tr.enabled);

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

  // Swapping does not move the tracks, it moves the boxes: the remote feed goes wherever the
  // big box is, which after a swap is the small one.
  useNativeVideoLayout({
    active: isNativeVideo && !!activeCall && activeCall.status === "active",
    // The media area itself, not the surface: the surface comes and goes with the peer's
    // picture, and your own picture-in-picture has to stay bounded while it is gone.
    clipEl: mediaEl,
    remoteEl: effectiveSwapped ? pipEl : bigEl,
    localEl: effectiveSwapped ? bigEl : pipEl,
    // Your own face is shown mirrored, the way every call app does it; the back camera is not.
    mirrorLocal: cameraFacing === "front",
  });

  // The big feed's srcObject follows whichever stream is foregrounded (muted —
  // audio always comes from the hidden <audio> element).
  const bigVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node) node.srcObject = bigStream ?? null;
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

  return (
    <>
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
            ref={attachMediaArea}
            className={`p2p-media-area${isCinema ? " cinema" : ""}`}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
          >
            {isNativeVideo && bigHasVideo ? (
              // Keyed on there being a picture, not the call type: a voice call can carry a screen share.
              <div ref={setBigEl} className="p2p-remote-video p2p-native-surface" />
            ) : bigHasVideo ? (
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
            {localHasCam && (isNativeVideo || pipStream) && (
              <DraggableVideo
                stream={isNativeVideo ? null : pipStream}
                onClick={bothHaveVideo ? handlePipClick : undefined}
                onElement={isNativeVideo ? setPipEl : undefined}
              />
            )}

            {/* Hover overlay — fullscreen + cinema, stacked. A flex column, not two boxes with
                offsets picked to miss each other: the gap is the browser's problem, and it
                cannot get it wrong on a device we have never seen. */}
            {bigHasVideo && !isNativeVideo && (
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
