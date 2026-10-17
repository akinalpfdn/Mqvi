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
  useServerStore.setState({ servers: [] });
  useFriendStore.setState({ friends: [], outgoing: [] });
  useVoiceStore.setState({ currentVoiceChannelId: null });
  useAuthStore.setState({ user: { id: "me", avatar_url: null } as User });
  useRoleStore.setState({ rolesByServer: {} });
});

afterEach(() => refreshFor.mockRestore());

describe("live guide progress", () => {
  it.each([
    ["joining or creating a server", "community", () => useServerStore.setState({ servers: [{ id: "s1" } as ServerListItem] })],
    ["sending a friend request", "friend", () => useFriendStore.setState({ outgoing: [{ id: "f1" } as FriendshipWithUser] })],
    ["joining voice", "voice", () => useVoiceStore.setState({ currentVoiceChannelId: "v1" })],
    ["setting an avatar", "profile", () => useAuthStore.setState({ user: { id: "me", avatar_url: "/a.png" } as User })],
    ["a role appearing", "roles", () => useRoleStore.setState({ rolesByServer: { s1: [] } })],
  ])("checks the step after %s", (_name, step, act) => {
    renderHook(() => useGuideProgress());
    act();
    expect(refreshFor).toHaveBeenCalledWith(step);
  });

  it("does not check on changes that do not count (leaving voice, losing a server)", () => {
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    useServerStore.setState({ servers: [{ id: "s1" } as ServerListItem] });
    renderHook(() => useGuideProgress());

    useVoiceStore.setState({ currentVoiceChannelId: null });
    useServerStore.setState({ servers: [] });

    expect(refreshFor).not.toHaveBeenCalled();
  });
});
