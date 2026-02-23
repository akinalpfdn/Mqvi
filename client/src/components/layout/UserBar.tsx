/**
 * UserBar — Sidebar alt kısmı: kullanıcı bilgisi + voice kontrolleri.
 *
 * VoicePopup'ın TÜM işlevselliğini devralır:
 * - Voice'a bağlıyken: Mic, Deafen, ScreenShare, Disconnect butonları gösterilir
 * - Bağlı değilken: sadece avatar + isim + settings ikonu
 *
 * CSS class'ları: .user-bar, .ub-user, .ub-avatar, .ub-info,
 * .ub-name, .ub-status, .ub-controls, .ub-ctrl, .ub-ctrl.active,
 * .ub-ctrl.ub-end, .ub-settings
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import Avatar from "../shared/Avatar";

type UserBarProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function UserBar({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: UserBarProps) {
  const { t } = useTranslation("voice");
  const user = useAuthStore((s) => s.user);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const isInVoice = !!currentVoiceChannelId;

  if (!user) return null;

  return (
    <div className="user-bar">
      {/* Voice kontrol satırı — kullanıcı adının ÜSTÜNDE, tam genişlik row.
          Discord referans: voice bağlıyken kontroller üstte ayrı row olarak durur. */}
      {isInVoice && (
        <div className="ub-voice-row">
          <div className="ub-voice-info">
            <span className="ub-voice-pulse" />
            <span className="ub-voice-label">{t("voiceConnected")}</span>
          </div>
          <div className="ub-voice-btns">
            <button
              className={`ub-ctrl${isMuted ? " active" : ""}`}
              onClick={onToggleMute}
              title={isMuted ? t("unmute") : t("mute")}
            >
              {/* Mic SVG — isMuted ise çizgili */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                {isMuted ? (
                  <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-9.7 4.7" />
                ) : (
                  <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
                )}
              </svg>
            </button>
            <button
              className={`ub-ctrl${isDeafened ? " active" : ""}`}
              onClick={onToggleDeafen}
              title={isDeafened ? t("undeafen") : t("deafen")}
            >
              {/* Headphones SVG */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                {isDeafened ? (
                  <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4z" />
                ) : (
                  <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5z" />
                )}
              </svg>
            </button>
            <button
              className={`ub-ctrl${isStreaming ? " active" : ""}`}
              onClick={onToggleScreenShare}
              title={isStreaming ? t("stopScreenShare") : t("screenShare")}
            >
              {/* Screen share SVG */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-2v-2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H3zm9 4a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2H9a1 1 0 1 1 0-2h2V9a1 1 0 0 1 1-1z" />
              </svg>
            </button>
            <button
              className="ub-ctrl ub-end"
              onClick={onDisconnect}
              title={t("endCall")}
            >
              {/* Disconnect SVG — phone icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c-3.5 0-6.6 1.1-9 3a1 1 0 0 0 0 1.4l2.5 2.5a1 1 0 0 0 1.2.1c.8-.5 1.7-.9 2.7-1.1a1 1 0 0 0 .8-1v-2.8c.6-.1 1.2-.1 1.8-.1s1.2 0 1.8.1v2.8a1 1 0 0 0 .8 1c1 .2 1.9.6 2.7 1.1a1 1 0 0 0 1.2-.1L21 12.4a1 1 0 0 0 0-1.4c-2.4-1.9-5.5-3-9-3z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Kullanıcı bilgisi + settings — her zaman altta */}
      <div className="ub-main">
        <div className="ub-user">
          <Avatar
            name={user.display_name || user.username}
            avatarUrl={user.avatar_url}
            size={32}
            isCircle
          />
          <div className="ub-info">
            <span className="ub-name">{user.display_name || user.username}</span>
            <span className="ub-status">#{user.username}</span>
          </div>
        </div>

        {/* Settings — her zaman görünür */}
        <button
          className="ub-ctrl ub-settings"
          onClick={() => openSettings("profile")}
          title="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-3.7a1.5 1.5 0 0 1 .3 1.7l-.9 1.5a1.5 1.5 0 0 1-1.6.7l-1.1-.2a7 7 0 0 1-1.2.7l-.3 1.1a1.5 1.5 0 0 1-1.4 1h-1.8a1.5 1.5 0 0 1-1.4-1l-.3-1.1a7 7 0 0 1-1.2-.7l-1.1.2a1.5 1.5 0 0 1-1.6-.7l-.9-1.5a1.5 1.5 0 0 1 .3-1.7l.8-.9V10a7 7 0 0 1 0-1.4l-.8-.9a1.5 1.5 0 0 1-.3-1.7l.9-1.5a1.5 1.5 0 0 1 1.6-.7l1.1.2a7 7 0 0 1 1.2-.7l.3-1.1a1.5 1.5 0 0 1 1.4-1h1.8a1.5 1.5 0 0 1 1.4 1l.3 1.1a7 7 0 0 1 1.2.7l1.1-.2a1.5 1.5 0 0 1 1.6.7l.9 1.5a1.5 1.5 0 0 1-.3 1.7l-.8.9a7 7 0 0 1 0 1.4l.8.9z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default UserBar;
