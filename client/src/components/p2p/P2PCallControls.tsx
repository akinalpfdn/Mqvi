/**
 * P2PCallControls — P2P arama kontrol butonları.
 *
 * Butonlar:
 * - Mikrofon toggle (mute/unmute)
 * - Kamera toggle (açık/kapalı) — sadece video call'da
 * - Ekran paylaşımı toggle
 * - Aramadan çık (kırmızı)
 *
 * minimal prop: ringing durumunda sadece "aramayı bitir" butonu gösterilir.
 *
 * CSS: .p2p-controls, .p2p-ctrl-btn, .p2p-ctrl-btn.active, .p2p-ctrl-btn.end-call
 */

import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";

type P2PCallControlsProps = {
  /** Minimal mod — sadece bitir butonu göster (ringing durumu) */
  minimal?: boolean;
};

function P2PCallControls({ minimal = false }: P2PCallControlsProps) {
  const { t } = useTranslation("common");
  const activeCall = useP2PCallStore((s) => s.activeCall);
  const isMuted = useP2PCallStore((s) => s.isMuted);
  const isVideoOn = useP2PCallStore((s) => s.isVideoOn);
  const isScreenSharing = useP2PCallStore((s) => s.isScreenSharing);
  const toggleMute = useP2PCallStore((s) => s.toggleMute);
  const toggleVideo = useP2PCallStore((s) => s.toggleVideo);
  const toggleScreenShare = useP2PCallStore((s) => s.toggleScreenShare);
  const endCall = useP2PCallStore((s) => s.endCall);
  const declineCall = useP2PCallStore((s) => s.declineCall);

  const isVideo = activeCall?.call_type === "video";
  const isRinging = activeCall?.status === "ringing";

  function handleEnd() {
    if (isRinging && activeCall) {
      declineCall(activeCall.id);
    } else {
      endCall();
    }
  }

  return (
    <div className="p2p-controls">
      {!minimal && (
        <>
          {/* Mikrofon toggle */}
          <button
            className={`p2p-ctrl-btn ${isMuted ? "active" : ""}`}
            onClick={toggleMute}
            title={t("toggleMic")}
          >
            {isMuted ? (
              /* Mic off SVG */
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
              </svg>
            ) : (
              /* Mic on SVG */
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
              </svg>
            )}
          </button>

          {/* Kamera toggle — sadece video call'da */}
          {isVideo && (
            <button
              className={`p2p-ctrl-btn ${!isVideoOn ? "active" : ""}`}
              onClick={toggleVideo}
              title={t("toggleCamera")}
            >
              {isVideoOn ? (
                /* Camera on SVG */
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              ) : (
                /* Camera off SVG */
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
                </svg>
              )}
            </button>
          )}

          {/* Ekran paylaşımı toggle */}
          <button
            className={`p2p-ctrl-btn ${isScreenSharing ? "active" : ""}`}
            onClick={toggleScreenShare}
            title={t("screenShare")}
          >
            {/* Screen share SVG */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />
            </svg>
          </button>
        </>
      )}

      {/* Aramayı bitir */}
      <button
        className="p2p-ctrl-btn end-call"
        onClick={handleEnd}
        title={t("endCall")}
      >
        {/* Phone hang up SVG */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85a1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
        </svg>
      </button>
    </div>
  );
}

export default P2PCallControls;
