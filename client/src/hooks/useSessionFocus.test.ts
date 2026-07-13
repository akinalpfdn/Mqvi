import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionFocus } from "./useSessionFocus";
import { useUIStore } from "../stores/uiStore";

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));

type Sent = { op: string; data: { focused: boolean; views: { type: string; id: string }[] } };

function mountWith(hasFocus: boolean, visibility: DocumentVisibilityState = "visible") {
  vi.spyOn(document, "hasFocus").mockReturnValue(hasFocus);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);

  const sent: Sent[] = [];
  const sendWS = (op: string, data?: unknown) => {
    sent.push({ op, data: data as Sent["data"] });
  };
  const view = renderHook(() => useSessionFocus({ sendWS, connectionStatus: "connected" }));
  return { sent, view };
}

/** One panel showing a DM — the shape the server keys its suppression off. */
function openDM(dmChannelId: string): void {
  useUIStore.setState({
    panels: {
      p1: {
        id: "p1",
        tabs: [{ id: "t1", channelId: dmChannelId, type: "dm", label: "friend" }],
        activeTabId: "t1",
      },
    },
    activePanelId: "p1",
  });
}

describe("useSessionFocus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUIStore.setState({ panels: {}, activePanelId: "p1" });
  });

  it("should report the open DM as on screen when the window is focused", () => {
    openDM("dm1");
    const { sent } = mountWith(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("focus_update");
    expect(sent[0].data).toEqual({ focused: true, views: [{ type: "dm", id: "dm1" }] });
  });

  // The whole point: a backgrounded device must not go on claiming it is reading the chat,
  // or the server suppresses the very push the user is waiting for.
  it("should claim nothing when the window is not focused", () => {
    openDM("dm1");
    const { sent } = mountWith(false);

    expect(sent[0].data).toEqual({ focused: false, views: [] });
  });

  it("should drop the claim when the window loses focus", () => {
    openDM("dm1");
    const { sent } = mountWith(true);

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(sent).toHaveLength(2);
    expect(sent[1].data).toEqual({ focused: false, views: [] });
  });

  it("should re-claim the new DM when the user switches conversations", () => {
    openDM("dm1");
    const { sent } = mountWith(true);

    act(() => openDM("dm2"));

    expect(sent).toHaveLength(2);
    expect(sent[1].data).toEqual({ focused: true, views: [{ type: "dm", id: "dm2" }] });
  });

  it("should not resend an unchanged state", () => {
    openDM("dm1");
    const { sent } = mountWith(true);

    // A store write that changes nothing we report (e.g. toggling the member list).
    act(() => useUIStore.setState({ membersOpen: false }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(sent).toHaveLength(1);
  });

  it("should stay silent while disconnected", () => {
    openDM("dm1");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    const sent: Sent[] = [];
    renderHook(() =>
      useSessionFocus({
        sendWS: (op, data) => sent.push({ op, data: data as Sent["data"] }),
        connectionStatus: "connecting",
      }),
    );

    expect(sent).toHaveLength(0);
  });
});
