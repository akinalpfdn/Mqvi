/** Losing one server must not hang up a call on another. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { handleSystemEvent } from "./systemEventHandlers";
import { useVoiceStore } from "../../stores/voiceStore";
import { useServerStore } from "../../stores/serverStore";
import type { WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

function serverDelete(id: string): WSMessage {
  return { op: "server_delete", d: { id }, seq: 1 } as unknown as WSMessage;
}

describe("server_delete", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(useServerStore.getState(), "handleServerDelete").mockImplementation(() => {});
  });

  it("should keep a call on another server", async () => {
    const disconnect = vi.fn();
    useVoiceStore.setState({ currentVoiceChannelId: "vc", currentVoiceServerId: "srv2", handleForceDisconnect: disconnect });

    await handleSystemEvent(serverDelete("srv1"), {} as WSHandlerContext, () => {});

    expect(disconnect).not.toHaveBeenCalled();
  });

  it("should end the call on the removed server", async () => {
    const disconnect = vi.fn();
    useVoiceStore.setState({ currentVoiceChannelId: "vc", currentVoiceServerId: "srv1", handleForceDisconnect: disconnect });

    await handleSystemEvent(serverDelete("srv1"), {} as WSHandlerContext, () => {});

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
