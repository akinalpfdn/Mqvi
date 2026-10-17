/** VoiceTourReplay — plays the voice panel tour again (Settings → Help); needs a voice channel. */

import { useTranslation } from "react-i18next";

import { useSettingsStore } from "../../stores/settingsStore";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { voicePanelTour } from "../../utils/guideTours";

function VoiceTourReplay() {
  const { t } = useTranslation("guide");
  const inVoice = useVoiceStore((s) => !!s.currentVoiceChannelId);

  function handlePlay() {
    // The panel sits under Settings; the user asked for the tour, so Settings steps aside.
    useSettingsStore.getState().closeSettings();
    useSpotlightStore.getState().open(voicePanelTour());
  }

  return (
    <div className="guide-restore">
      <div>
        <div className="guide-restore-title">{t("voiceTourTitle")}</div>
        <div className="settings-field-hint">{inVoice ? t("voiceTourDesc") : t("voiceTourNeedsVoice")}</div>
      </div>
      <button type="button" className="settings-btn" onClick={handlePlay} disabled={!inVoice}>
        {t("voiceTourButton")}
      </button>
    </div>
  );
}

export default VoiceTourReplay;
