/**
 * "Show me" for each guide step. Steps done in the sidebar get a spotlight on the real control
 * (GuideSpotlight); the user does the step themselves. Steps that live in a dialog or outside
 * the app open it directly.
 */

import { useAuthStore } from "../stores/authStore";
import { useMobileStore } from "../stores/mobileStore";
import { useServerStore } from "../stores/serverStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSidebarStore } from "../stores/sidebarStore";
import { useSpotlightStore } from "../stores/spotlightStore";
import type { GuideStepId } from "../types";
import { detectOS } from "./detectOS";
import { STEP_TOUR } from "./guideTargets";

/** Makes the sidebar's targets exist and show: drawer open, sidebar and sections expanded. */
function revealSidebar(isMobile: boolean): void {
  if (isMobile) useMobileStore.getState().openLeftDrawer();
  else useSidebarStore.getState().expandSidebar();
  const sidebar = useSidebarStore.getState();
  sidebar.expandSection("servers");
  sidebar.expandSection("friends");
  const activeServerId = useServerStore.getState().activeServerId;
  if (activeServerId) sidebar.expandSection(`srv:${activeServerId}`);
}

function ownsActiveServer(): boolean {
  const server = useServerStore.getState().activeServer;
  return !!server && server.owner_id === useAuthStore.getState().user?.id;
}

export function showGuideStep(step: GuideStepId, isMobile: boolean): void {
  if (step === "profile") {
    useSettingsStore.getState().openSettings("profile");
    return;
  }
  if (step === "app") {
    window.open(detectOS().url, "_blank", "noopener,noreferrer");
    return;
  }
  if (step === "roles" && ownsActiveServer()) {
    useSettingsStore.getState().openSettings("roles");
    return;
  }

  const targets = STEP_TOUR[step];
  if (!targets) return;
  revealSidebar(isMobile);
  useSpotlightStore.getState().open(step, targets);
}
