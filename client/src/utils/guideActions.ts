/**
 * "Show me" for each guide step: takes the user to where the step is done. The user does the
 * step themselves; the guide only gets them there.
 */

import i18n from "../i18n";
import { useAuthStore } from "../stores/authStore";
import { useChannelStore } from "../stores/channelStore";
import { useMobileStore } from "../stores/mobileStore";
import { useServerStore } from "../stores/serverStore";
import { useSettingsStore } from "../stores/settingsStore";
import { detectOS } from "./detectOS";
import { useUIStore } from "../stores/uiStore";
import type { GuideStepId } from "../types";

/** Opens the active server's first text channel as a tab. False when there is none. */
function openFirstTextChannel(): boolean {
  const server = useServerStore.getState().activeServer;
  if (!server) return false;
  const channel = useChannelStore
    .getState()
    .categories.flatMap((c) => c.channels)
    .find((ch) => ch.type === "text");
  if (!channel) return false;
  useUIStore.getState().openTab(channel.id, "text", channel.name, {
    serverId: server.id,
    serverName: server.name,
    serverIconUrl: server.icon_url,
  });
  return true;
}

export function showGuideStep(step: GuideStepId, isMobile: boolean): void {
  const ui = useUIStore.getState();
  switch (step) {
    case "community":
      ui.openDiscovery();
      return;
    case "message":
      if (!openFirstTextChannel() && isMobile) useMobileStore.getState().openLeftDrawer();
      return;
    case "voice":
      // Joining voice is the user's own choice: show them the channel list, never join for them.
      if (isMobile) useMobileStore.getState().openLeftDrawer();
      return;
    case "friend":
    case "dm":
      // Friends are where a direct message starts.
      ui.openTab("friends", "friends", i18n.t("common:friends"));
      return;
    case "profile":
      useSettingsStore.getState().openSettings("profile");
      return;
    case "roles": {
      // Roles are made in a server you own; elsewhere there is nothing to open yet.
      const server = useServerStore.getState().activeServer;
      if (server && server.owner_id === useAuthStore.getState().user?.id) {
        useSettingsStore.getState().openSettings("roles");
      } else if (isMobile) {
        useMobileStore.getState().openLeftDrawer();
      }
      return;
    }
    case "app":
      window.open(detectOS().url, "_blank", "noopener,noreferrer");
      return;
  }
}
