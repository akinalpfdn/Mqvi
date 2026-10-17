/** "Show me" starts a tour and opens nothing by itself. */
import { describe, it, expect, beforeEach } from "vitest";

import { showGuideStep } from "./guideActions";
import { useSpotlightStore } from "../stores/spotlightStore";
import { useMobileStore } from "../stores/mobileStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useServerStore } from "../stores/serverStore";
import { useAuthStore } from "../stores/authStore";
import type { Server, ServerListItem, User } from "../types";

beforeEach(() => {
  useSpotlightStore.setState({ tour: null });
  useMobileStore.setState({ leftDrawerOpen: false });
  useSettingsStore.setState({ isOpen: false });
  useServerStore.setState({ activeServer: null, activeServerId: null, servers: [] });
  useAuthStore.setState({ user: { id: "me" } as User });
});

describe("Show me", () => {
  it.each(["community", "message", "voice", "friend", "profile", "roles"] as const)(
    "starts the %s tour without opening a drawer or a dialog",
    (step) => {
      showGuideStep(step);
      expect(useSpotlightStore.getState().tour?.step).toBe(step);
      expect(useMobileStore.getState().leftDrawerOpen).toBe(false);
      expect(useSettingsStore.getState().isOpen).toBe(false);
    },
  );

  it("takes the owner of any server to its roles, even from another server", () => {
    useServerStore.setState({
      activeServer: { id: "s2", owner_id: "someone" } as Server,
      servers: [
        { id: "s1", owner_id: "me" } as ServerListItem,
        { id: "s2", owner_id: "someone" } as ServerListItem,
      ],
    });
    showGuideStep("roles");
    expect(useSpotlightStore.getState().tour?.scope).toBe("roles");
  });

  it("sends someone with no server of their own to create one", () => {
    useServerStore.setState({ servers: [{ id: "s2", owner_id: "someone" } as ServerListItem] });
    showGuideStep("roles");
    expect(useSpotlightStore.getState().tour?.scope).toBe("rolesNoServer");
  });
});
