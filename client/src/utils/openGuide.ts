/** Opens (or focuses) the guide tab. */

import i18n from "../i18n";
import { useMobileStore } from "../stores/mobileStore";
import { useUIStore } from "../stores/uiStore";
import { GUIDE_TAB_ID } from "./guideScript";

export function openGuide(): void {
  useUIStore.getState().openTab(GUIDE_TAB_ID, "guide", i18n.t("guide:name"));
  useMobileStore.getState().closeAllDrawers();
}
