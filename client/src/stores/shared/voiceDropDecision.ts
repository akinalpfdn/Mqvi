/**
 * What to do after the SFU drops this client while the store still says it is in voice.
 *
 * A network drop should be healed by rejoining. A removal should not: an admin disconnect, kick,
 * AFK kick or lost permission removes the user from the SFU at the same moment the server sends
 * its own signal over the WebSocket, and the two travel separately. When the SFU's word arrives
 * first, rejoining put the user straight back in the channel they were just removed from.
 *
 * The server's voice state decides. It is changed before the server asks the SFU to remove anyone,
 * so by the time a removal reaches the client it already says where the user is now.
 */
import { getVoiceStates } from "../../api/voice";

export type VoiceDropDecision = "rejoin" | "stay" | "drop";

export async function decideAfterVoiceDrop(params: {
  serverId: string | null;
  userId: string | null;
  channelId: string;
  /** The SFU said it removed us (or deleted the room). A plain drop is rejoined without asking. */
  removedBySFU: boolean;
}): Promise<VoiceDropDecision> {
  const { serverId, userId, channelId, removedBySFU } = params;
  if (!removedBySFU || !serverId || !userId) return "rejoin";

  let res;
  try {
    res = await getVoiceStates(serverId);
  } catch {
    return "rejoin";
  }
  // No answer is not a "no": behave as before and let the rejoin's own token request decide.
  if (!res.success || !res.data) return "rejoin";

  const own = res.data.find((s) => s.user_id === userId);
  if (!own) return "drop"; // removed from voice
  if (own.channel_id === channelId) return "rejoin"; // the server still has us here
  return "stay"; // moved: the force-move signal switches rooms
}
