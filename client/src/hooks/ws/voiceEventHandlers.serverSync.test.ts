/** A per-server voice resync reaches the store and replaces only that server. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../../utils/sounds", () => ({ playJoinSound: vi.fn(), playLeaveSound: vi.fn() }));

import { handleVoiceEvent } from "./voiceEventHandlers";
import { useVoiceStore } from "../../stores/voiceStore";
import type { WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

const entry = (user_id: string, channel_id: string, server_id: string) => ({
  user_id, channel_id, server_id, username: user_id, display_name: user_id, avatar_url: "",
  is_muted: false, is_deafened: false, is_streaming: false, is_server_muted: false, is_server_deafened: false,
});

describe("voice_server_states_sync", () => {
  it("should replace that server's voice states without re-joining voice", async () => {
    const sendVoiceJoin = vi.fn();
    useVoiceStore.setState({
      voiceStates: { hidden: [entry("spy", "hidden", "srv1")], other: [entry("u2", "other", "srv2")] },
      channelTimers: { hidden: 1, other: 2 },
      currentVoiceChannelId: "elsewhere",
    });

    const handled = await handleVoiceEvent(
      { op: "voice_server_states_sync", d: { server_id: "srv1", states: [], channel_timers: {} }, seq: 1 } as unknown as WSMessage,
      { sendVoiceJoin } as unknown as WSHandlerContext
    );

    expect(handled).toBe(true);
    const { voiceStates, channelTimers } = useVoiceStore.getState();
    expect(voiceStates.hidden).toBeUndefined();
    expect(voiceStates.other).toHaveLength(1);
    expect(channelTimers).toEqual({ other: 2 });
    expect(sendVoiceJoin).not.toHaveBeenCalled();
  });
});
