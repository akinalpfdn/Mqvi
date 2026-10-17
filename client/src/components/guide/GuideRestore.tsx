/** GuideRestore — brings a hidden guide back (Settings → Help). Shows only while hidden. */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useGuideStore } from "../../stores/guideStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { openGuide } from "../../utils/openGuide";

function GuideRestore() {
  const { t } = useTranslation("guide");
  const hidden = useGuideStore((s) => s.hidden);
  const setHidden = useGuideStore((s) => s.setHidden);
  const [busy, setBusy] = useState(false);

  if (!hidden) return null;

  async function handleRestore() {
    setBusy(true);
    const ok = await setHidden(false);
    setBusy(false);
    if (!ok) return;
    useSettingsStore.getState().closeSettings();
    openGuide();
  }

  return (
    <div className="guide-restore">
      <div>
        <div className="guide-restore-title">{t("restoreTitle")}</div>
        <div className="settings-field-hint">{t("restoreDesc")}</div>
      </div>
      <button type="button" className="settings-btn" onClick={handleRestore} disabled={busy}>
        {t("restoreButton")}
      </button>
    </div>
  );
}

export default GuideRestore;
