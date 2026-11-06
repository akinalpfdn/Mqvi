/** Rejoin a network drop; never rejoin a removal. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api/voice", () => ({ getVoiceStates: vi.fn() }));

import { getVoiceStates } from "../../api/voice";
import { decideAfterVoiceDrop } from "./voiceDropDecision";

const states = vi.mocked(getVoiceStates);
const me = (channel_id: string) => ({ user_id: "me", channel_id }) as never;
const removal = { serverId: "srv1", userId: "me", channelId: "vc", removedBySFU: true };

describe("decideAfterVoiceDrop", () => {
  beforeEach(() => {
    states.mockReset();
  });

  it("should rejoin a plain drop without asking the server", async () => {
    expect(await decideAfterVoiceDrop({ ...removal, removedBySFU: false })).toBe("rejoin");
    expect(states).not.toHaveBeenCalled();
  });

  it("should drop when the server no longer has us in voice (admin disconnect, kick, AFK)", async () => {
    states.mockResolvedValue({ success: true, data: [{ user_id: "other", channel_id: "vc" } as never] });
    expect(await decideAfterVoiceDrop(removal)).toBe("drop");
  });

  it("should stay when the server moved us — the force-move switches rooms", async () => {
    states.mockResolvedValue({ success: true, data: [me("target")] });
    expect(await decideAfterVoiceDrop(removal)).toBe("stay");
  });

  it("should rejoin when the server still has us in the channel", async () => {
    states.mockResolvedValue({ success: true, data: [me("vc")] });
    expect(await decideAfterVoiceDrop(removal)).toBe("rejoin");
  });

  it("should fall back to the old rejoin when the server answers with an error", async () => {
    states.mockResolvedValue({ success: false, error: "HTTP 500" });
    expect(await decideAfterVoiceDrop(removal)).toBe("rejoin");
  });

  it("should fall back to the old rejoin when the server cannot be reached", async () => {
    states.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(await decideAfterVoiceDrop(removal)).toBe("rejoin");
  });
});
