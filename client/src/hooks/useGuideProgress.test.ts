/** Each thing the user does that a step counts makes the guide check that step. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

import { useGuideProgress } from "./useGuideProgress";
import { useGuideStore } from "../stores/guideStore";
import { useServerStore } from "../stores/serverStore";
import { useFriendStore } from "../stores/friendStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";
import { useRoleStore } from "../stores/roleStore";
import type { FriendshipWithUser, ServerListItem, User } from "../types";

let refreshFor: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  refreshFor = vi.spyOn(useGuideStore.getState(), "refreshFor").mockImplementation(() => {});
  useServerStore.setState({
    servers: [{ id: "own", owner_id: "me" } as ServerListItem, { id: "theirs", owner_id: "x" } as ServerListItem],
  });
  useFriendStore.setState({ friends: [], outgoing: [] });
  useVoiceStore.setState({ currentVoiceChannelId: null });
  useAuthStore.setState({ user: { id: "me", avatar_url: null } as User });
  useRoleStore.setState({ rolesByServer: {} });
});

afterEach(() => refreshFor.mockRestore());

describe("live guide progress", () => {
  it.each([
    ["joining or creating a server", "community", () =>
      useServerStore.setState((st) => ({ servers: [...st.servers, { id: "s1", owner_id: "x" } as ServerListItem] }))],
    ["sending a friend request", "friend", () => useFriendStore.setState({ outgoing: [{ id: "f1" } as FriendshipWithUser] })],
    ["joining voice", "voice", () => useVoiceStore.setState({ currentVoiceChannelId: "v1" })],
    ["setting an avatar", "profile", () => useAuthStore.setState({ user: { id: "me", avatar_url: "/a.png" } as User })],
    ["a role changing in a server the user owns", "roles", () => useRoleStore.setState({ rolesByServer: { own: [] } })],
  ])("checks the step after %s", (_name, step, act) => {
    renderHook(() => useGuideProgress());
    act();
    expect(refreshFor).toHaveBeenCalledWith(step);
  });

  it("does not check on changes that do not count (leaving voice, losing a server)", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    renderHook(() => useGuideProgress());

    useVoiceStore.setState({ currentVoiceChannelId: null });
    useServerStore.setState({ servers: [] });

    expect(refreshFor).not.toHaveBeenCalled();
  });

  it("does not check roles changing in someone else's server (every server switch refetches them)", () => {
    renderHook(() => useGuideProgress());
    useRoleStore.setState({ rolesByServer: { theirs: [] } });
    expect(refreshFor).not.toHaveBeenCalled();
  });
});
