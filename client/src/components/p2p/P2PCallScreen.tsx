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
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";

// ─── Draggable Local PiP ───

function DraggableLocalVideo({ stream }: { stream: MediaStream }) {
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

  const onPointerUp = useCallback(() => {
    setDragging(false);
    dragState.current = null;
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`p2p-local-video-wrap${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
  const currentUserId = useAuthStore((s) => s.user?.id);

  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  // Hidden audio element — always plays remote stream audio regardless of video state
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

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
          <div className="p2p-media-area">
            {hasRemoteVideo ? (
              <video
                ref={remoteVideoRef}
                className="p2p-remote-video"
                autoPlay
                playsInline
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

            {/* Local PiP — draggable, independent of remote video state */}
            {hasLocalVideo && isVideoOn && !isScreenSharing && localStream && (
              <DraggableLocalVideo stream={localStream} />
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
