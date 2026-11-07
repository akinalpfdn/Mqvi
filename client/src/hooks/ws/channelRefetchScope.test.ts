/**
 * Channel-tree events name their server. The client keeps one tree per server and tabs open across
 * servers, so an event about another server must neither refetch the one on screen — every online
 * member of that server would do so at once — nor judge another server's tab against it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const trees: Record<string, CategoryWithChannels[]> = {};
vi.mock("../../api/channels", () => ({
  getChannels: vi.fn(async (serverId: string) => ({ success: true, data: trees[serverId] ?? [] })),
}));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { handleChannelEvent } from "./channelEventHandlers";
import { handleSystemEvent } from "./systemEventHandlers";
import { getChannels } from "../../api/channels";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore } from "../../stores/uiStore";
import type { CategoryWithChannels, Channel, WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

const ON_SCREEN = "srv-a";
const ELSEWHERE = "srv-b";

function tree(serverId: string, channelIds: string[]): CategoryWithChannels[] {
  // Fixture: only id and server_id are read by the code under test.
  const channels = channelIds.map((id) => ({ id, server_id: serverId }) as unknown as Channel);
  return [{ category: { id: "", name: "", position: 0 } as CategoryWithChannels["category"], channels }];
}

function event(op: string, serverId: string | undefined, d: unknown = null): WSMessage {
  // Fixture: the handlers read op, d and server_id only.
  return { op, d, server_id: serverId, seq: 1 } as unknown as WSMessage;
}

function fetchedServers(): string[] {
  return vi.mocked(getChannels).mock.calls.map(([serverId]) => serverId);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function tabIsOpen(channelId: string): boolean {
  return Object.values(useUIStore.getState().panels).some((p) => p.tabs.some((t) => t.channelId === channelId));
}

beforeEach(() => {
  vi.mocked(getChannels).mockClear();
  for (const key of Object.keys(trees)) delete trees[key];
  useServerStore.setState({ activeServerId: ON_SCREEN });
  useChannelStore.setState({
    categories: tree(ON_SCREEN, ["a1"]),
    categoriesByServer: { [ON_SCREEN]: tree(ON_SCREEN, ["a1"]), [ELSEWHERE]: tree(ELSEWHERE, ["b1"]) },
  });
});

describe("channel-tree events scoped to their server", () => {
  it.each(["channel_create", "channel_reorder", "category_reorder"])(
    "should not refetch the server on screen when %s happens on another server",
    async (op) => {
      await handleChannelEvent(event(op, ELSEWHERE));
      await settle();

      expect(fetchedServers()).toEqual([]);
      expect(useChannelStore.getState().categoriesByServer[ELSEWHERE]).toBeUndefined();
    },
  );

  it.each(["role_update", "role_delete"])(
    "should not refetch the server on screen when %s happens on another server",
    async (op) => {
      await handleSystemEvent(event(op, ELSEWHERE, { id: "r1" }), {} as WSHandlerContext, () => {});
      await settle();

      expect(fetchedServers()).toEqual([]);
      expect(useChannelStore.getState().categoriesByServer[ELSEWHERE]).toBeUndefined();
    },
  );

  it("should refetch the server on screen when its own tree changes", async () => {
    await handleChannelEvent(event("channel_create", ON_SCREEN));
    await settle();

    expect(fetchedServers()).toEqual([ON_SCREEN]);
  });

  it("should keep another server's tab open when a permission change leaves its channel visible", async () => {
    trees[ON_SCREEN] = tree(ON_SCREEN, ["a1"]);
    trees[ELSEWHERE] = tree(ELSEWHERE, ["b1"]);
    useUIStore.getState().openTab("b1", "text", "b1", { serverId: ELSEWHERE, serverName: "B", serverIconUrl: null });

    await handleChannelEvent(event("channel_permission_update", ELSEWHERE, { channel_id: "b1", role_id: "r1" }));
    await settle();

    expect(tabIsOpen("b1")).toBe(true);
    expect(fetchedServers()).toEqual([ELSEWHERE]);
  });

  it("should close another server's tab when a permission change hides its channel", async () => {
    trees[ELSEWHERE] = tree(ELSEWHERE, []);
    useUIStore.getState().openTab("b1", "text", "b1", { serverId: ELSEWHERE, serverName: "B", serverIconUrl: null });

    await handleChannelEvent(event("channel_permission_delete", ELSEWHERE, { channel_id: "b1", role_id: "r1" }));
    await settle();

    expect(tabIsOpen("b1")).toBe(false);
  });

  it("should treat an event without a server as the server on screen", async () => {
    await handleChannelEvent(event("channel_reorder", undefined));
    await settle();

    expect(fetchedServers()).toEqual([ON_SCREEN]);
  });
});
