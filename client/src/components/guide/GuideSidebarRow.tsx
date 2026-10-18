/** GuideSidebarRow — the mqvi Guide, pinned at the top of the direct messages. */

import { useTranslation } from "react-i18next";

import { useGuideStore } from "../../stores/guideStore";
import { useUIStore } from "../../stores/uiStore";
import { GUIDE_TAB_ID } from "../../utils/guideScript";
import { openGuide } from "../../utils/openGuide";
import { publicAsset } from "../../utils/constants";

function GuideSidebarRow() {
  const { t } = useTranslation("guide");
  const hidden = useGuideStore((s) => s.hidden);
  const isActive = useUIStore((s) => {
    const panel = s.panels[s.activePanelId];
    return panel?.tabs.find((tb) => tb.id === panel.activeTabId)?.channelId === GUIDE_TAB_ID;
  });

  if (hidden) return null;

  return (
    <button type="button" className={`ch-tree-item ch-tree-dm ch-tree-guide${isActive ? " active" : ""}`} onClick={openGuide}>
      <img src={publicAsset("mqvi-icon-128.png")} alt="" className="guide-avatar" />
      <span className="ch-tree-label">{t("name")}</span>
      <span className="guide-badge guide-badge-sm">{t("badge")}</span>
    </button>
  );
}

export default GuideSidebarRow;
