/**
 * Reconnecting refills every open conversation, because nothing replays the events the dead socket
 * missed. But reconnecting is not reading — only the tab actually on screen may clear its badge.
 * These tests pin both halves, since getting the second one wrong silently destroys unread state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../api/messages", () => ({ getMessages: vi.fn() }));
vi.mock("../../api/dm", () => ({ getDMMessages: vi.fn(async () => ({ success: false })) }));
vi.mock("../../api/readState", () => ({
  markRead: vi.fn(async () => ({ success: true })),
  getUnreadCounts: vi.fn(async () => ({ success: false })),
  markAllRead: vi.fn(async () => ({ success: true })),
  markMentionSeen: vi.fn(async () => ({ success: true })),
}));
vi.mock("../../crypto/channelEncryption", () => ({
  decryptChannelMessages: vi.fn(async (m: unknown[]) => m),
  encryptChannelMessage: vi.fn(),
}));
vi.mock("../../crypto/dmEncryption", () => ({
  decryptDMMessages: vi.fn(async (m: unknown[]) => m),
  encryptDMMessage: vi.fn(),
  pushSentPlaintext: vi.fn(),
  discardLastSentPlaintext: vi.fn(),
  persistSentPlaintext: vi.fn(),
  cacheEditPlaintext: vi.fn(),
}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { resyncOpenTabs } from "./systemEventHandlers";
import { useUIStore, type Panel } from "../../stores/uiStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";
import * as messageApi from "../../api/messages";
import type { Message } from "../../types";

const SERVER = "server-1";
const ON_SCREEN = "channel-on-screen";
const BACKGROUND = "channel-background";

function message(id: string, channelId: string): Message {
  return {
    id,
    channel_id: channelId,
    user_id: "someone-else",
    content: "hi",
    encryption_version: 0,
    created_at: "2026-07-29 10:00:00",
  } as Message;
}

/** One panel holding two text tabs, the first of them active. */
function panelWithTwoTabs(): Record<string, Panel> {
  return {
    "panel-1": {
      id: "panel-1",
      activeTabId: "tab-on-screen",
      tabs: [
        {
          id: "tab-on-screen",
          channelId: ON_SCREEN,
          type: "text",
          label: "on-screen",
          serverInfo: { serverId: SERVER, serverName: "s", serverIconUrl: null },
        },
        {
          id: "tab-background",
          channelId: BACKGROUND,
          type: "text",
          label: "background",
          serverInfo: { serverId: SERVER, serverName: "s", serverIconUrl: null },
        },
      ],
    },
  };
}

function pageFor(channelId: string) {
  return {
    success: true as const,
    data: { messages: [message(`m-${channelId}`, channelId)], has_more: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  useUIStore.setState({ panels: panelWithTwoTabs(), activePanelId: "panel-1" });
  useMessageStore.setState({ messagesByChannel: {}, hasMoreByChannel: {} });

  // markAsRead resolves the server from this map and bails without it, so the badge assertions
  // would pass for the wrong reason if it were empty.
  useReadStateStore.setState({
    channelServerMap: { [ON_SCREEN]: SERVER, [BACKGROUND]: SERVER },
    unreadCounts: { [ON_SCREEN]: 3, [BACKGROUND]: 5 },
  });

  vi.mocked(messageApi.getMessages).mockImplementation(
    async (_serverId: string, channelId: string) => pageFor(channelId) as never
  );
});

describe("resyncOpenTabs", () => {
  it("should refill every open tab, not only the one on screen", async () => {
    await resyncOpenTabs();

    const fetched = vi.mocked(messageApi.getMessages).mock.calls.map((c) => c[1]);
    expect(fetched).toContain(ON_SCREEN);
    expect(fetched).toContain(BACKGROUND);
  });

  it("should mark read only the tab on screen", async () => {
    await resyncOpenTabs();

    const { unreadCounts } = useReadStateStore.getState();
    expect(unreadCounts[ON_SCREEN]).toBeUndefined();
    // The user never looked at this one. Clearing it here would destroy unread state and, on the
    // DM path, retract the push from the device that was going to show it.
    expect(unreadCounts[BACKGROUND]).toBe(5);
  });

  it("should keep refilling the remaining tabs when one channel fails", async () => {
    vi.mocked(messageApi.getMessages).mockImplementation(
      async (_serverId: string, channelId: string) => {
        if (channelId === ON_SCREEN) throw new Error("network");
        return pageFor(channelId) as never;
      }
    );

    await resyncOpenTabs();

    expect(useMessageStore.getState().messagesByChannel[BACKGROUND]).toHaveLength(1);
  });

  it("should skip tabs that carry no message history", async () => {
    useUIStore.setState({
      panels: {
        "panel-1": {
          id: "panel-1",
          activeTabId: "tab-voice",
          tabs: [
            { id: "tab-voice", channelId: "voice-1", type: "voice", label: "General" },
            { id: "tab-friends", channelId: "friends", type: "friends", label: "Friends" },
          ],
        },
      },
    });

    await resyncOpenTabs();

    expect(messageApi.getMessages).not.toHaveBeenCalled();
  });
});
