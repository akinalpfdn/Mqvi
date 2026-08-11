/**
 * Moderation actions that no longer wait for the WebSocket.
 *
 * Kicking, banning and re-roling used to be api calls made straight from the member list and the
 * settings panel: the list only changed when member_leave / member_update came back. With the
 * socket down the moderator saw the person they had just removed still sitting there.
 *
 * Same two hazards as the channel slice — the change must land with no WS event, and the echo
 * replaying it moments later must be a no-op — plus one specific to roles: changing your OWN roles
 * changes which channels you are allowed to see.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MemberWithRoles } from "../types";

const api = vi.hoisted(() => ({
  modifyMemberRoles: vi.fn(),
  kickMember: vi.fn(),
  banMember: vi.fn(),
  getMembers: vi.fn(),
}));
vi.mock("../api/members", () => api);

vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "s1" }) },
}));

let myUserId = "me";
vi.mock("./authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: myUserId } }) },
}));

const fetchChannels = vi.fn();
vi.mock("./channelStore", () => ({
  useChannelStore: { getState: () => ({ fetchChannels }) },
}));

const { useMemberStore } = await import("./memberStore");

// A full MemberWithRoles is a User plus a Role[], and Role alone has a dozen permission fields. The
// store keys on `id` and stores the object whole, so only these five say anything here. `as unknown`
// is needed because the partial roles do not overlap Role enough for a direct assertion.
const member = (id: string, roleNames: string[] = []): MemberWithRoles =>
  ({
    id,
    username: id,
    display_name: id,
    status: "online",
    roles: roleNames.map((n, i) => ({ id: n, name: n, position: i })),
    effective_permissions: roleNames.length ? "2" : "1",
  }) as unknown as MemberWithRoles;

const ok = <T,>(data: T) => ({ success: true as const, data });
const fail = (error?: string) => ({ success: false as const, error });

function memberIds(): string[] {
  return (useMemberStore.getState().membersByServer["s1"] ?? []).map((m) => m.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  myUserId = "me";
  useMemberStore.setState({
    membersByServer: { s1: [member("me"), member("target")] },
    onlineUserIds: new Set(["me", "target"]),
    loadingServers: new Set(),
    isLoading: false,
  });
});

describe("moderation without the socket", () => {
  it("should remove a kicked member from the list with no WS event", async () => {
    api.kickMember.mockResolvedValue(ok({ message: "ok" }));

    expect((await useMemberStore.getState().kickMember("target")).ok).toBe(true);

    expect(memberIds()).toEqual(["me"]);
  });

  // A ban emits member_leave, not a ban event — so the removal is the store's job either way.
  it("should remove a banned member from the list with no WS event", async () => {
    api.banMember.mockResolvedValue(ok({ message: "ok" }));

    expect((await useMemberStore.getState().banMember("target", "spam")).ok).toBe(true);

    expect(memberIds()).toEqual(["me"]);
  });

  it("should apply new roles with no WS event", async () => {
    api.modifyMemberRoles.mockResolvedValue(ok(member("target", ["mod"])));

    expect((await useMemberStore.getState().modifyMemberRoles("target", ["mod"])).ok).toBe(true);

    const updated = useMemberStore.getState().membersByServer["s1"].find((m) => m.id === "target");
    expect(updated?.roles.map((r) => r.id)).toEqual(["mod"]);
  });

  it("should drop a kicked member from the online set too", async () => {
    api.kickMember.mockResolvedValue(ok({ message: "ok" }));

    await useMemberStore.getState().kickMember("target");

    // Left behind, they keep counting toward the online tally in the member list header.
    expect(useMemberStore.getState().onlineUserIds.has("target")).toBe(false);
  });
});

describe("the echo replaying a local moderation action", () => {
  it("should not bring a kicked member back", async () => {
    api.kickMember.mockResolvedValue(ok({ message: "ok" }));
    await useMemberStore.getState().kickMember("target");

    useMemberStore.getState().handleMemberLeave("s1", "target");

    expect(memberIds()).toEqual(["me"]);
  });

  it("should leave the new roles in place", async () => {
    const updated = member("target", ["mod"]);
    api.modifyMemberRoles.mockResolvedValue(ok(updated));
    await useMemberStore.getState().modifyMemberRoles("target", ["mod"]);

    useMemberStore.getState().handleMemberUpdate("s1", updated);

    expect(memberIds()).toEqual(["me", "target"]);
    const after = useMemberStore.getState().membersByServer["s1"].find((m) => m.id === "target");
    expect(after?.roles.map((r) => r.id)).toEqual(["mod"]);
  });
});

// Roles decide channel visibility, so re-roling yourself can add or remove channels from the tree.
// The member_update handler refetches for this; the store action has to as well, or a self-demotion
// leaves channels on screen that the server would no longer serve.
describe("re-roling yourself", () => {
  it("should refetch the channel tree when the target is me", async () => {
    api.modifyMemberRoles.mockResolvedValue(ok(member("me", ["mod"])));

    await useMemberStore.getState().modifyMemberRoles("me", ["mod"]);

    expect(fetchChannels).toHaveBeenCalled();
  });

  it("should not refetch when the target is someone else", async () => {
    api.modifyMemberRoles.mockResolvedValue(ok(member("target", ["mod"])));

    await useMemberStore.getState().modifyMemberRoles("target", ["mod"]);

    expect(fetchChannels).not.toHaveBeenCalled();
  });
});

describe("a moderation call the server rejects", () => {
  it("should keep the member and pass the server's reason back", async () => {
    api.kickMember.mockResolvedValue(fail("cannot kick a member with a higher role"));

    const res = await useMemberStore.getState().kickMember("target");

    expect(res.ok).toBe(false);
    // The reason is specific and worth showing; a generic "something went wrong" hides why.
    expect(res.error).toBe("cannot kick a member with a higher role");
    expect(memberIds()).toEqual(["me", "target"]);
  });

  it("should keep a member the ban did not go through for", async () => {
    api.banMember.mockResolvedValue(fail("cannot ban a member with a higher role"));

    const res = await useMemberStore.getState().banMember("target", "spam");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("cannot ban a member with a higher role");
    // Removing them here would show a moderator that the ban worked when it did not.
    expect(memberIds()).toEqual(["me", "target"]);
  });

  it("should keep the old roles", async () => {
    api.modifyMemberRoles.mockResolvedValue(fail("role above your own"));

    const res = await useMemberStore.getState().modifyMemberRoles("target", ["admin"]);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("role above your own");
    const after = useMemberStore.getState().membersByServer["s1"].find((m) => m.id === "target");
    expect(after?.roles).toEqual([]);
  });

  it("should not refetch channels when re-roling myself fails", async () => {
    api.modifyMemberRoles.mockResolvedValue(fail("nope"));

    await useMemberStore.getState().modifyMemberRoles("me", ["mod"]);

    expect(fetchChannels).not.toHaveBeenCalled();
  });
});
