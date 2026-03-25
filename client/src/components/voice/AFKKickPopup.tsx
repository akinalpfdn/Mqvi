/**
 * AFKKickPopup — Humorous modal shown when user is kicked for AFK in voice.
 * Requires manual dismiss — no auto-close, no click-outside.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";

function AFKKickPopup() {
  const { t } = useTranslation("voice");
  const afkKickInfo = useVoiceStore((s) => s.afkKickInfo);
  const dismissAFKKick = useVoiceStore((s) => s.dismissAFKKick);

  if (!afkKickInfo) return null;

  return (
    <div className="afk-kick-overlay">
      <div className="afk-kick-popup">
        <div className="afk-kick-emoji">😴</div>
        <h2 className="afk-kick-title">{t("afkKickTitle")}</h2>
        <p className="afk-kick-message">
          {t("afkKickMessage", {
            channel: afkKickInfo.channelName,
            server: afkKickInfo.serverName,
          })}
        </p>
        <p className="afk-kick-subtitle">{t("afkKickSubtitle")}</p>
        <button className="afk-kick-btn" onClick={dismissAFKKick}>
          {t("afkKickDismiss")}
        </button>
      </div>
    </div>
  );
}

export default AFKKickPopup;
