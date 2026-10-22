/**
 * Device row 11: after A signed out and B signed in, A's open chat tabs came back for B. The app
 * does not reload between accounts, so the in-memory state has to go at sign-out.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DMMessage, Message, User } from "../types";

vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const { useResetOnSignOut } = await import("./useResetOnSignOut");
const { useAuthStore } = await import("../stores/authStore");
const { useUIStore } = await import("../stores/uiStore");
const { useMessageStore } = await import("../stores/messageStore");
const { useDMStore } = await import("../stores/dmStore");
const { useServerStore } = await import("../stores/serverStore");
const { useReadStateStore } = await import("../stores/readStateStore");
const { useSoundboardStore } = await import("../stores/soundboardStore");

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({ user: { id: "alice" } as User });
});

function signInAsAliceWithState() {
  useUIStore.getState().openTab("d1", "dm", "bob");
  useMessageStore.setState({ messagesByChannel: { c1: [{ id: "m1" } as Message] } });
  useDMStore.setState({ messagesByChannel: { d1: [{ id: "dm1" } as DMMessage] }, channels: [{ id: "d1" }] as never });
  useServerStore.getState().setActiveServer("s1");
  useReadStateStore.setState({ unreadCounts: { c1: 3 } });
  useSoundboardStore.setState({ volume: 0.3 });
}

describe("signing out", () => {
  it("should leave none of the signed-out account's tabs, messages or servers for the next one", () => {
    renderHook(() => useResetOnSignOut());
    signInAsAliceWithState();

    useAuthStore.setState({ user: null });
    useAuthStore.setState({ user: { id: "bob" } as User });

    const tabs = Object.values(useUIStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs).toEqual([]);
    expect(useMessageStore.getState().messagesByChannel).toEqual({});
    expect(useDMStore.getState().messagesByChannel).toEqual({});
    expect(useDMStore.getState().channels).toEqual([]);
    expect(useReadStateStore.getState().unreadCounts).toEqual({});
    expect(useServerStore.getState().activeServerId).toBeNull();
    expect(localStorage.getItem("mqvi_last_server")).toBeNull();
  });

  it("should keep device preferences", () => {
    renderHook(() => useResetOnSignOut());
    signInAsAliceWithState();

    useAuthStore.setState({ user: null });

    expect(useSoundboardStore.getState().volume).toBe(0.3);
  });

  it("should let the next account fetch its conversations, not think them already loaded", async () => {
    renderHook(() => useResetOnSignOut());
    useMessageStore.getState().hydrateConversation("c1", [{ id: "m1" } as Message], false);

    useAuthStore.setState({ user: null });

    // hydrateConversation skips a conversation already in the store; empty again, it takes it.
    useMessageStore.getState().hydrateConversation("c1", [{ id: "m2" } as Message], false);
    expect(useMessageStore.getState().messagesByChannel["c1"].map((m) => m.id)).toEqual(["m2"]);
  });
});

describe("requests in flight at sign-out", () => {
  it("should not let a request the signed-out account started write into the next one's stores", async () => {
    renderHook(() => useResetOnSignOut());
    // A real fetch rejects when its signal aborts; this one does too, and otherwise answers late.
    let answer!: () => void;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      answer = () => resolve(new Response(JSON.stringify({ success: true, data: [{ id: "alice-server" }] }), { status: 200 }));
    })));
    localStorage.setItem("access_token", "a");

    const fetching = useServerStore.getState().fetchServers();
    useAuthStore.setState({ user: null }); // signed out while it was in flight
    answer();
    await fetching;

    expect(useServerStore.getState().servers).toEqual([]);
    vi.unstubAllGlobals();
  });
});

