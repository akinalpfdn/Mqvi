/**
 * A status picked on one device holds on all of them. The server tells the user's own devices the
 * pick, so each one's status picker — and its idle detection, which stands down under any pick but
 * online — follows.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { handleSystemEvent } from "./systemEventHandlers";
import { useAuthStore } from "../../stores/authStore";
import type { User, WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

function presence(d: Record<string, unknown>): WSMessage {
  return { op: "presence_update", d, seq: 1 } as unknown as WSMessage;
}

async function deliver(msg: WSMessage) {
  await handleSystemEvent(msg, {} as WSHandlerContext, () => {});
}

beforeEach(() => {
  // Fixture: only id and status are read.
  useAuthStore.setState({ user: { id: "me", status: "online" } as User, manualStatus: "online" });
});

describe("presence_update carrying the user's pick", () => {
  it("should adopt a status picked on another of the user's devices", async () => {
    await deliver(presence({ user_id: "me", status: "dnd", pref_status: "dnd" }));

    expect(useAuthStore.getState().manualStatus).toBe("dnd");
  });

  it("should keep the pick when the visible status is only an automatic idle", async () => {
    await deliver(presence({ user_id: "me", status: "idle", pref_status: "online" }));

    expect(useAuthStore.getState().manualStatus).toBe("online");
    expect(useAuthStore.getState().user?.status).toBe("idle");
  });

  it("should leave the pick alone when an older server sends no pick", async () => {
    useAuthStore.setState({ manualStatus: "dnd" });

    await deliver(presence({ user_id: "me", status: "online" }));

    expect(useAuthStore.getState().manualStatus).toBe("dnd");
  });

  it("should never take another user's status as the user's pick", async () => {
    await deliver(presence({ user_id: "someone", status: "dnd", pref_status: "dnd" }));

    expect(useAuthStore.getState().manualStatus).toBe("online");
  });
});
