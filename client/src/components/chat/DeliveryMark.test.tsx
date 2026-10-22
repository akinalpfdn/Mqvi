/** The sender's own message: clock until the server stored it, then a single tick. */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PendingMessage } from "../../stores/outboxStore";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const { default: DeliveryMark } = await import("./DeliveryMark");
const { deliveryState } = await import("../../utils/deliveryState");

const pending = (status: PendingMessage["status"]) => ({ status }) as PendingMessage;

describe("deliveryState", () => {
  it.each([
    ["an own message the server stored", true, "channel", undefined, "sent"],
    ["an own DM the server stored", true, "dm", undefined, "sent"],
    ["an own message still sending", true, "channel", pending("sending"), "pending"],
    ["an own message that failed (its bubble says so)", true, "dm", pending("failed"), null],
    ["someone else's message", false, "channel", undefined, null],
    ["voice chat (sent in the foreground)", true, "voice", undefined, null],
  ] as const)("should show the right mark for %s", (_, isOwn, mode, p, want) => {
    expect(deliveryState(isOwn, mode, p)).toBe(want);
  });
});

describe("DeliveryMark", () => {
  it("should label the clock and the tick for screen readers", () => {
    const { rerender } = render(<DeliveryMark state="pending" />);
    expect(screen.getByRole("img", { name: "messageSending" })).toBeTruthy();

    rerender(<DeliveryMark state="sent" />);
    expect(screen.getByRole("img", { name: "messageSent" })).toBeTruthy();
  });
});
