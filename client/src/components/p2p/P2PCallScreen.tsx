/**
 * P2PCallScreen — Main P2P call screen.
 *
 * Rendered when tab.type === "p2p" in PanelView.
 *
 * States: ringing (avatar + cancel), active audio (avatar + duration),
 * active video (remote large + local PiP + controls).
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";

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
  const localVideoRef = useRef<HTMLVideoElement>(null);
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

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

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
              <>
                <video
                  ref={remoteVideoRef}
                  className="p2p-remote-video"
                  autoPlay
                  playsInline
                />
                {/* Local PiP — hidden during screen share (camera track is replaced) */}
                {hasLocalVideo && isVideoOn && !isScreenSharing && (
                  <video
                    ref={localVideoRef}
                    className="p2p-local-video"
                    autoPlay
                    playsInline
                    muted
                  />
                )}
              </>
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
          </div>

          <div className="p2p-duration">{formatDuration(callDuration)}</div>
          <P2PCallControls />
        </div>
      ) : null}
    </>
  );
}

export default P2PCallScreen;
