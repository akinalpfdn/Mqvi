/** A device signed out from another one hears it over its socket and tears down at once. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { handleSystemEvent } from "./systemEventHandlers";
import { useAuthStore } from "../../stores/authStore";
import type { WSMessage } from "../../types";
import type { WSHandlerContext } from "./types";

describe("session_revoked", () => {
  it("should sign this device out locally", async () => {
    const forceLogout = vi.spyOn(useAuthStore.getState(), "forceLogout").mockResolvedValue(undefined);

    const handled = await handleSystemEvent(
      { op: "session_revoked", d: null, seq: 1 } as unknown as WSMessage,
      {} as WSHandlerContext,
      () => {}
    );

    expect(handled).toBe(true);
    expect(forceLogout).toHaveBeenCalledTimes(1);
    forceLogout.mockRestore();
  });
});
