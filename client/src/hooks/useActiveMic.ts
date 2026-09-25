/**
 * The microphone the user bar, the mute shortcuts and /mute act on: an answered p2p call's while
 * there is one, channel voice's otherwise. The two are never live together (a call leaves voice as
 * it starts), and a call that only rings has no microphone yet.
 */

import { useCallback } from "react";

import { useP2PCallStore, type P2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";

function callOwnsMic(state: Pick<P2PCallStore, "activeCall">): boolean {
  return state.activeCall?.status === "active";
}

/** Whether the microphone the user bar shows is muted. */
export function useActiveMicMuted(): boolean {
  const callHasMic = useP2PCallStore(callOwnsMic);
  const callMuted = useP2PCallStore((s) => s.isMuted);
  const voiceMuted = useVoiceStore((s) => s.isMuted);
  return callHasMic ? callMuted : voiceMuted;
}

/** Channel voice's mute toggle, sent to the call instead while an answered call owns the microphone. */
export function useToggleActiveMute(toggleVoiceMute: () => void): () => void {
  return useCallback(() => {
    const call = useP2PCallStore.getState();
    if (callOwnsMic(call)) call.toggleMute();
    else toggleVoiceMute();
  }, [toggleVoiceMute]);
}
