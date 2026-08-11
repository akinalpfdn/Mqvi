/**
 * Server settings changes that no longer wait for the WebSocket.
 *
 * The settings panel held the server in its own `useState`, so renaming one updated the form and
 * nothing else: the sidebar entry kept the old name and icon until the server_update echo came
 * back. The sidebar is the copy the user actually looks at.
 *
 * `handleServerUpdate` also rebuilds the list entry through `toServerListItem`, which is what keeps
 * `verified` and `e2ee_enabled` from being dropped — six hand-built literals used to lose them.
 * Pinned below, since routing the mutation through the store is what makes that reuse automatic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Server, ServerListItem } from "../types";

const api = vi.hoisted(() => ({
  updateServer: vi.fn(),
  uploadServerIcon: vi.fn(),
  uploadServerBanner: vi.fn(),
  getServers: vi.fn(),
}));
vi.mock("../api/servers", () => api);

vi.mock("./channelStore", () => ({ useChannelStore: { getState: () => ({}) } }));
vi.mock("./readStateStore", () => ({ useReadStateStore: { getState: () => ({}) } }));
vi.mock("./e2eeStore", () => ({ useE2EEStore: { getState: () => ({}) } }));
vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => ({}) } }));
vi.mock("./uiStore", () => ({ useUIStore: { getState: () => ({}) } }));

const { useServerStore } = await import("./serverStore");

const server = (over: Partial<Server> = {}): Server =>
  ({
    id: "s1",
    name: "original",
    icon_url: null,
    verified: true,
    e2ee_enabled: true,
    ...over,
  }) as Server;

const listItem = (over: Partial<ServerListItem> = {}): ServerListItem =>
  ({
    id: "s1",
    name: "original",
    icon_url: null,
    verified: true,
    e2ee_enabled: true,
    ...over,
  }) as ServerListItem;

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = (error?: string) => ({ success: false as const, error });

const sidebar = () => useServerStore.getState().servers[0];

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({
    servers: [listItem(), listItem({ id: "s2", name: "other" })],
    activeServerId: "s1",
    activeServer: server(),
  });
});

describe("server settings without the socket", () => {
  it("should rename the sidebar entry, not just the settings form", async () => {
    api.updateServer.mockResolvedValue(ok(server({ name: "renamed" })));

    const res = await useServerStore.getState().updateServer("s1", { name: "renamed" });

    expect(res.server?.name).toBe("renamed");
    expect(sidebar().name).toBe("renamed");
    expect(useServerStore.getState().activeServer?.name).toBe("renamed");
  });

  it("should show a new icon in the sidebar immediately", async () => {
    api.uploadServerIcon.mockResolvedValue(ok(server({ icon_url: "/icons/new.png" })));

    await useServerStore.getState().uploadServerIcon("s1", new File([""], "i.png"));

    expect(sidebar().icon_url).toBe("/icons/new.png");
  });

  it("should apply a banner upload to the active server", async () => {
    api.uploadServerBanner.mockResolvedValue(ok(server({ banner_url: "/b.png" } as Partial<Server>)));

    await useServerStore.getState().uploadServerBanner("s1", new File([""], "b.png"));

    expect(useServerStore.getState().activeServer?.banner_url).toBe("/b.png");
  });

  // The list entry is rebuilt from the full server, so fields the settings screen never touches
  // have to survive. Dropping e2ee_enabled makes the list claim an encrypted server is plaintext.
  it("should keep verified and e2ee_enabled when only the name changed", async () => {
    api.updateServer.mockResolvedValue(ok(server({ name: "renamed" })));

    await useServerStore.getState().updateServer("s1", { name: "renamed" });

    expect(sidebar().verified).toBe(true);
    expect(sidebar().e2ee_enabled).toBe(true);
  });

  it("should not touch a different server in the list", async () => {
    api.updateServer.mockResolvedValue(ok(server({ name: "renamed" })));

    await useServerStore.getState().updateServer("s1", { name: "renamed" });

    expect(useServerStore.getState().servers[1].name).toBe("other");
  });
});

describe("the echo replaying a local server update", () => {
  it("should leave the rename in place", async () => {
    const renamed = server({ name: "renamed" });
    api.updateServer.mockResolvedValue(ok(renamed));
    await useServerStore.getState().updateServer("s1", { name: "renamed" });

    useServerStore.getState().handleServerUpdate(renamed);

    expect(useServerStore.getState().servers).toHaveLength(2);
    expect(sidebar().name).toBe("renamed");
  });
});

describe("a server update the server rejects", () => {
  it("should leave the sidebar alone and pass the reason back", async () => {
    api.updateServer.mockResolvedValue(fail("name already taken"));

    const res = await useServerStore.getState().updateServer("s1", { name: "renamed" });

    expect(res.server).toBeNull();
    expect(res.error).toBe("name already taken");
    expect(sidebar().name).toBe("original");
  });

  it("should not change the icon when the upload fails", async () => {
    api.uploadServerIcon.mockResolvedValue(fail("too large"));

    const res = await useServerStore.getState().uploadServerIcon("s1", new File([""], "i.png"));

    expect(res.server).toBeNull();
    expect(sidebar().icon_url).toBeNull();
  });

  it("should not change the banner when the upload fails", async () => {
    api.uploadServerBanner.mockResolvedValue(fail("too large"));

    const res = await useServerStore.getState().uploadServerBanner("s1", new File([""], "b.png"));

    expect(res.server).toBeNull();
    expect(useServerStore.getState().activeServer?.name).toBe("original");
  });
});
