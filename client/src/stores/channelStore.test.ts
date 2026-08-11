/**
 * Channel mutations that no longer wait for the WebSocket.
 *
 * These used to be api calls made straight from the components: the tree only changed when the
 * server echoed the event back. With the socket down or reconnecting the mutation succeeded and the
 * UI showed the old tree — the exact failure this phase exists to remove.
 *
 * Moving the update onto the acting client creates the opposite hazard. The echo still arrives a
 * moment later and replays the same change, so any handler that appends rather than merges shows
 * the thing twice. Both directions are pinned below: the mutation lands with no WS event at all,
 * and the echo afterwards is a no-op.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Channel, Category, CategoryWithChannels } from "../types";

const api = vi.hoisted(() => ({
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}));
vi.mock("../api/channels", () => api);

const updateTabLabel = vi.fn();
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => ({ updateTabLabel }) },
}));

const handleForceDisconnect = vi.fn();
let currentVoiceChannelId: string | null = null;
vi.mock("./voiceStore", () => ({
  useVoiceStore: { getState: () => ({ currentVoiceChannelId, handleForceDisconnect }) },
}));

vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "s1" }) },
}));

const { useChannelStore } = await import("./channelStore");

const channel = (id: string, categoryId: string | null, name = id): Channel =>
  ({ id, name, type: "text", category_id: categoryId, position: 0 }) as Channel;

const category = (id: string, name = id): Category => ({ id, name, position: 0 }) as Category;

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = { success: false as const, error: "nope" };

/** Every channel in the tree, so a duplicate is visible as a count rather than a shape. */
function channelIds(): string[] {
  return useChannelStore
    .getState()
    .categories.flatMap((cg) => cg.channels.map((ch) => ch.id));
}

function categoryIds(): string[] {
  return useChannelStore.getState().categories.map((cg) => cg.category.id);
}

const tree = (): CategoryWithChannels[] => [
  { category: category("c1"), channels: [channel("ch1", "c1")] },
];

beforeEach(() => {
  vi.clearAllMocks();
  currentVoiceChannelId = null;
  useChannelStore.setState({
    categories: tree(),
    categoriesByServer: {},
    selectedChannelId: null,
    isLoading: false,
    mutedChannelIds: new Set(),
  });
});

describe("channel mutations without the socket", () => {
  it("should add the created channel to the tree with no WS event", async () => {
    api.createChannel.mockResolvedValue(ok(channel("ch2", "c1")));

    const created = await useChannelStore.getState().createChannel({
      name: "ch2",
      type: "text",
      category_id: "c1",
    });

    expect(created?.id).toBe("ch2");
    expect(channelIds()).toEqual(["ch1", "ch2"]);
  });

  it("should rename in the tree with no WS event", async () => {
    api.updateChannel.mockResolvedValue(ok(channel("ch1", "c1", "renamed")));

    expect(await useChannelStore.getState().updateChannel("ch1", { name: "renamed" })).toBe(true);

    expect(useChannelStore.getState().categories[0].channels[0].name).toBe("renamed");
  });

  it("should remove the deleted channel from the tree with no WS event", async () => {
    api.deleteChannel.mockResolvedValue(ok({ message: "ok" }));

    expect(await useChannelStore.getState().deleteChannel("ch1")).toBe(true);

    expect(channelIds()).toEqual([]);
  });

  it("should add the created category with no WS event", async () => {
    api.createCategory.mockResolvedValue(ok(category("c2")));

    expect(await useChannelStore.getState().createCategory("c2")).not.toBeNull();

    expect(categoryIds()).toEqual(["c1", "c2"]);
  });

  it("should rename the category with no WS event", async () => {
    api.updateCategory.mockResolvedValue(ok(category("c1", "renamed")));

    expect(await useChannelStore.getState().updateCategory("c1", { name: "renamed" })).toBe(true);

    expect(useChannelStore.getState().categories[0].category.name).toBe("renamed");
  });

  it("should remove the deleted category with no WS event", async () => {
    api.deleteCategory.mockResolvedValue(ok({ message: "ok" }));

    expect(await useChannelStore.getState().deleteCategory("c1")).toBe(true);

    expect(categoryIds()).toEqual([]);
  });
});

// The other half of moving the update onto the client. The server echoes every one of these back,
// and the acting client processes its own echo like anyone else's.
describe("the echo replaying a local mutation", () => {
  it("should not add the channel a second time", async () => {
    const created = channel("ch2", "c1");
    api.createChannel.mockResolvedValue(ok(created));
    await useChannelStore.getState().createChannel({ name: "ch2", type: "text", category_id: "c1" });

    useChannelStore.getState().handleChannelCreate(created);

    expect(channelIds()).toEqual(["ch1", "ch2"]);
  });

  it("should not add the category a second time, and must not empty it", async () => {
    const created = category("c2");
    api.createCategory.mockResolvedValue(ok(created));
    await useChannelStore.getState().createCategory("c2");
    // A channel lands in the new category before the echo arrives.
    useChannelStore.getState().handleChannelCreate(channel("ch2", "c2"));

    useChannelStore.getState().handleCategoryCreate(created);

    expect(categoryIds()).toEqual(["c1", "c2"]);
    // Re-adding as `{ category, channels: [] }` would drop ch2 with nothing to show for it.
    expect(channelIds()).toEqual(["ch1", "ch2"]);
  });

  it("should leave a deleted channel deleted", async () => {
    api.deleteChannel.mockResolvedValue(ok({ message: "ok" }));
    await useChannelStore.getState().deleteChannel("ch1");

    useChannelStore.getState().handleChannelDelete("ch1");

    expect(channelIds()).toEqual([]);
  });

  it("should leave a renamed channel renamed", async () => {
    const renamed = channel("ch1", "c1", "renamed");
    api.updateChannel.mockResolvedValue(ok(renamed));
    await useChannelStore.getState().updateChannel("ch1", { name: "renamed" });

    useChannelStore.getState().handleChannelUpdate(renamed);

    expect(channelIds()).toEqual(["ch1"]);
    expect(useChannelStore.getState().categories[0].channels[0].name).toBe("renamed");
  });

  // A create event for a channel that has since moved must not leave a copy behind in both.
  it("should not leave a stale copy when the echo carries a different category", () => {
    useChannelStore.getState().handleCategoryCreate(category("c2"));
    useChannelStore.getState().handleChannelCreate(channel("ch1", "c2"));

    expect(channelIds()).toEqual(["ch1"]);
    expect(useChannelStore.getState().categories[1].channels[0].id).toBe("ch1");
  });
});

// A rejected mutation must leave the tree exactly as it was: the whole point is that the tree
// reflects what the server accepted, not what the user attempted.
describe("a mutation the server rejects", () => {
  it("should not remove the channel", async () => {
    api.deleteChannel.mockResolvedValue(fail);

    expect(await useChannelStore.getState().deleteChannel("ch1")).toBe(false);

    expect(channelIds()).toEqual(["ch1"]);
  });

  it("should not rename the channel", async () => {
    api.updateChannel.mockResolvedValue(fail);

    expect(await useChannelStore.getState().updateChannel("ch1", { name: "renamed" })).toBe(false);

    expect(useChannelStore.getState().categories[0].channels[0].name).toBe("ch1");
  });

  it("should not add the channel, and should report the failure", async () => {
    api.createChannel.mockResolvedValue(fail);

    expect(
      await useChannelStore.getState().createChannel({ name: "ch2", type: "text" })
    ).toBeNull();

    expect(channelIds()).toEqual(["ch1"]);
  });

  it("should not remove the category", async () => {
    api.deleteCategory.mockResolvedValue(fail);

    expect(await useChannelStore.getState().deleteCategory("c1")).toBe(false);

    expect(categoryIds()).toEqual(["c1"]);
  });

  it("should not rename the category", async () => {
    api.updateCategory.mockResolvedValue(fail);

    expect(await useChannelStore.getState().updateCategory("c1", { name: "renamed" })).toBe(false);

    expect(useChannelStore.getState().categories[0].category.name).toBe("c1");
  });

  it("should not add the category, and should report the failure", async () => {
    api.createCategory.mockResolvedValue(fail);

    expect(await useChannelStore.getState().createCategory("c2")).toBeNull();

    expect(categoryIds()).toEqual(["c1"]);
  });
});

// These two effects used to sit in the WS handler, which meant the client that performed the action
// did not get them until its own echo came back — and never, if the socket was down.
describe("effects that used to be WS-only", () => {
  it("should relabel an open tab when the channel is renamed locally", async () => {
    api.updateChannel.mockResolvedValue(ok(channel("ch1", "c1", "renamed")));

    await useChannelStore.getState().updateChannel("ch1", { name: "renamed" });

    expect(updateTabLabel).toHaveBeenCalledWith("ch1", "renamed");
  });

  it("should tear down voice when the channel being deleted is the one we are in", async () => {
    currentVoiceChannelId = "ch1";
    api.deleteChannel.mockResolvedValue(ok({ message: "ok" }));

    await useChannelStore.getState().deleteChannel("ch1");

    expect(handleForceDisconnect).toHaveBeenCalled();
  });

  it("should leave voice alone when a different channel is deleted", async () => {
    currentVoiceChannelId = "other";
    api.deleteChannel.mockResolvedValue(ok({ message: "ok" }));

    await useChannelStore.getState().deleteChannel("ch1");

    expect(handleForceDisconnect).not.toHaveBeenCalled();
  });
});
