/**
 * P2PCallScreen — Ana P2P arama ekranı.
 *
 * PanelView'da tab.type === "p2p" olduğunda render edilir.
 *
 * 3 durum gösterir:
 * 1. **Ringing (caller):** Büyük avatar + "Aranıyor..." + iptal butonu
 * 2. **Active (sesli):** Büyük avatar + süre + kontroller
 * 3. **Active (görüntülü):** Video grid (remote büyük + local küçük) + kontroller
 *
 * CSS: .p2p-call-screen, .p2p-ringing, .p2p-active, .p2p-avatar-large,
 *       .p2p-duration, .p2p-status-text
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";

/**
 * formatDuration — Saniye cinsinden süreyi "mm:ss" formatına çevirir.
 */
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

  /** Remote video element ref'i — remoteStream değiştiğinde srcObject set edilir */
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  /** Local video element ref'i */
  const localVideoRef = useRef<HTMLVideoElement>(null);
  /**
   * Remote audio element ref'i — her zaman remote stream'i çalar.
   *
   * Neden ayrı audio element?
   * Video call'da <video> elementi hem sesi hem görüntüyü çalar.
   * Ama sesli arama'da veya video kapalıyken <video> render edilmez →
   * karşı tarafın sesi hiçbir yerde çalmaz. Bu gizli <audio> elementi
   * remote stream'i HER DURUMDA çalar — video açık olsa da olmasa da.
   */
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Remote stream → audio element bağlantısı (her zaman aktif)
  useEffect(() => {
    if (remoteAudioRef.current && remoteStream) {
      remoteAudioRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Remote stream → video element bağlantısı
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Local stream → video element bağlantısı
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Karşı tarafın bilgilerini belirle
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

  /**
   * Render: Tek return ile gizli <audio> elementi her zaman DOM'da kalır.
   *
   * Neden tek return?
   * Gizli <audio> elementi remote stream'in ses track'lerini çalar.
   * Early return kullansak bu element bazı durumlarda render edilmez →
   * karşı tarafın sesi kesilir. Tek return ile audio HER ZAMAN aktif.
   */
  return (
    <>
      {/* Gizli audio element — remote stream'in sesini HER ZAMAN çalar.
          Video açık olsa da olmasa da ses buradan gelir.
          style={{display:"none"}} yerine CSS class kullanmıyoruz çünkü
          bu element hiçbir zaman görünmemeli, layout'u etkilememeli. */}
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
          {/* Video grid veya büyük avatar */}
          <div className="p2p-media-area">
            {hasRemoteVideo ? (
              <>
                {/* Remote video (büyük) — video call veya screen share olabilir.
                    call_type kontrolü yok: voice call'da screen share açılırsa da
                    video track gelir — gösterilmeli. */}
                <video
                  ref={remoteVideoRef}
                  className="p2p-remote-video"
                  autoPlay
                  playsInline
                />
                {/* Local video (küçük overlay, sağ alt) — sadece kamera açıksa göster.
                    Screen share aktifken local preview gösterilmez (kamera track'i
                    sender'da replace edilmiş olabilir). */}
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
              /* Sesli arama veya video kapalı → büyük avatar */
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

          {/* Süre */}
          <div className="p2p-duration">{formatDuration(callDuration)}</div>

          {/* Kontroller */}
          <P2PCallControls />
        </div>
      ) : null}
    </>
  );
}

export default P2PCallScreen;
