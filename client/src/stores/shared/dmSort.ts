import type { DMChannelWithUser } from "../../types";

export function sortChannelsByActivity(channels: DMChannelWithUser[]): DMChannelWithUser[] {
  return [...channels].sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;
    const aTime = a.last_message_at ?? a.created_at;
    const bTime = b.last_message_at ?? b.created_at;
    return bTime.localeCompare(aTime);
  });
}
