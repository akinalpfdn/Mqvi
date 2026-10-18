/** Overrides are fetched once per channel, even when asked again before the first answer. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({ getOverrides: vi.fn() }));
vi.mock("../api/channelPermissions", () => api);

import { useChannelPermissionStore } from "./channelPermissionStore";
import { useServerStore } from "./serverStore";

beforeEach(() => {
  api.getOverrides.mockReset();
  useChannelPermissionStore.setState({ overridesByChannel: {}, fetchedChannels: new Set() });
  useServerStore.setState({ activeServerId: "s1" });
});

describe("fetching channel overrides", () => {
  it("does not repeat a fetch still in flight", async () => {
    let answer: (v: unknown) => void = () => {};
    api.getOverrides.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { fetchOverridesForChannels } = useChannelPermissionStore.getState();

    fetchOverridesForChannels(["c1"]);
    fetchOverridesForChannels(["c1"]); // the channel list changed while the first was out
    expect(api.getOverrides).toHaveBeenCalledTimes(1);

    answer({ success: true, data: [] });
    await vi.waitFor(() => expect(useChannelPermissionStore.getState().fetchedChannels.has("c1")).toBe(true));
  });

  it("can try again after a failed fetch", async () => {
    api.getOverrides.mockResolvedValue({ success: false });
    await useChannelPermissionStore.getState().fetchOverrides("c1");
    await useChannelPermissionStore.getState().fetchOverrides("c1");
    expect(api.getOverrides).toHaveBeenCalledTimes(2);
  });
});
