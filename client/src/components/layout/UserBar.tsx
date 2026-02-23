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
      {/* Voice kontrolleri — sadece voice'a bağlıyken gösterilir */}
      {isInVoice && (
        <div className="ub-voice-strip">
          <span className="ub-voice-pulse" />
          <span className="ub-voice-label">{t("voiceConnected")}</span>
        </div>
      )}

      <div className="ub-main">
        {/* Kullanıcı bilgisi */}
        <div className="ub-user">
          <Avatar
            name={user.display_name || user.username}
            avatarUrl={user.avatar_url}
            size={28}
            isCircle
          />
          <div className="ub-info">
            <span className="ub-name">{user.display_name || user.username}</span>
            <span className="ub-status">#{user.username}</span>
          </div>
        </div>

        {/* Kontroller */}
        <div className="ub-controls">
          {isInVoice && (
            <>
              <button
                className={`ub-ctrl${isMuted ? " active" : ""}`}
                onClick={onToggleMute}
                title={isMuted ? t("unmute") : t("mute")}
              >
                {"\uD83C\uDFA4"}
              </button>
              <button
                className={`ub-ctrl${isDeafened ? " active" : ""}`}
                onClick={onToggleDeafen}
                title={isDeafened ? t("undeafen") : t("deafen")}
              >
                {"\uD83C\uDFA7"}
              </button>
              <button
                className={`ub-ctrl${isStreaming ? " active" : ""}`}
                onClick={onToggleScreenShare}
                title={isStreaming ? t("stopScreenShare") : t("screenShare")}
              >
                {"\uD83D\uDDA5"}
              </button>
              <button
                className="ub-ctrl ub-end"
                onClick={onDisconnect}
                title={t("endCall")}
              >
                &#x2716;
              </button>
            </>
          )}

          {/* Settings — her zaman görünür */}
          <button
            className="ub-ctrl ub-settings"
            onClick={() => openSettings("profile")}
            title="Settings"
          >
            &#x2699;
          </button>
        </div>
      </div>
    </div>
  );
}

export default UserBar;
