/** What the sender's own message shows for delivery. */

import type { PendingMessage } from "../stores/outboxStore";

export type DeliveryState = "pending" | "sent" | "delivered";

/**
 * What the sender's own message shows. Nothing on anyone else's message, nothing on a failed send
 * (its bubble already says so), nothing in voice chat (sent in the foreground, no pending state).
 * The double tick is DMs only: in a channel "reached the other side" has no single other side.
 */
export function deliveryState(
  isOwn: boolean,
  mode: "channel" | "dm" | "voice",
  pending: PendingMessage | undefined,
  delivered?: boolean
): DeliveryState | null {
  if (!isOwn || mode === "voice") return null;
  if (pending) return pending.status === "sending" ? "pending" : null;
  return mode === "dm" && delivered ? "delivered" : "sent";
}
