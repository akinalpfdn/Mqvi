/** Where each "Show me" goes. */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

import { showGuideStep } from "./guideActions";
import { useSpotlightStore } from "../stores/spotlightStore";
import { useMobileStore } from "../stores/mobileStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useServerStore } from "../stores/serverStore";
import { useAuthStore } from "../stores/authStore";
import type { Server, User } from "../types";

beforeEach(() => {
  useSpotlightStore.setState({ request: null });
  useMobileStore.setState({ leftDrawerOpen: false });
  useSettingsStore.setState({ isOpen: false });
  useServerStore.setState({ activeServer: null, activeServerId: null });
  useAuthStore.setState({ user: { id: "me" } as User });
});

describe("Show me", () => {
  it("spotlights the sidebar control, opening the drawer on a phone first", () => {
    showGuideStep("community", true);

    expect(useMobileStore.getState().leftDrawerOpen).toBe(true);
    expect(useSpotlightStore.getState().request).toMatchObject({ step: "community", targets: ["discover"] });
  });

  it("does not touch the drawer on desktop", () => {
    showGuideStep("friend", false);

    expect(useMobileStore.getState().leftDrawerOpen).toBe(false);
    expect(useSpotlightStore.getState().request?.step).toBe("friend");
  });

  it("opens profile settings directly", () => {
    showGuideStep("profile", false);
    expect(useSettingsStore.getState().isOpen).toBe(true);
    expect(useSpotlightStore.getState().request).toBeNull();
  });

  it("opens role settings for the owner of the server in view", () => {
    useServerStore.setState({ activeServer: { id: "s1", owner_id: "me" } as Server });
    showGuideStep("roles", false);
    expect(useSettingsStore.getState().isOpen).toBe(true);
  });

  it("points someone without a server of their own at creating one", () => {
    useServerStore.setState({ activeServer: { id: "s1", owner_id: "someone" } as Server });
    showGuideStep("roles", false);

    expect(useSettingsStore.getState().isOpen).toBe(false);
    expect(useSpotlightStore.getState().request).toMatchObject({ step: "roles", targets: ["add-server"] });
  });
});
