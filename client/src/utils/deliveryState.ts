/** What the sender's own message shows for delivery. */

import type { PendingMessage } from "../stores/outboxStore";

export type DeliveryState = "pending" | "sent";

/**
 * What the sender's own message shows. Nothing on anyone else's message, nothing on a failed send
 * (its bubble already says so), nothing in voice chat (sent in the foreground, no pending state).
 */
export function deliveryState(
  isOwn: boolean,
  mode: "channel" | "dm" | "voice",
  pending: PendingMessage | undefined
): DeliveryState | null {
  if (!isOwn || mode === "voice") return null;
  if (!pending) return "sent";
  return pending.status === "sending" ? "pending" : null;
}
