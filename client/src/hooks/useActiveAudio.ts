/**
 * The microphone and the output the user bar, the mute and deafen shortcuts, and /mute and /deafen
 * act on: an answered p2p call's while there is one, channel voice's otherwise. The two are never
 * live together (a call leaves voice as it starts), and a call that only rings has neither yet.
 */

import { useCallback } from "react";

import { useP2PCallStore, type P2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";

function callOwnsAudio(state: Pick<P2PCallStore, "activeCall">): boolean {
  return state.activeCall?.status === "active";
}

/** Whether the microphone the user bar shows is muted. */
export function useActiveMicMuted(): boolean {
  const callHasAudio = useP2PCallStore(callOwnsAudio);
  const callMuted = useP2PCallStore((s) => s.isMuted);
  const voiceMuted = useVoiceStore((s) => s.isMuted);
  return callHasAudio ? callMuted : voiceMuted;
}

/** Whether the output the user bar shows is deafened. */
export function useActiveDeafened(): boolean {
  const callHasAudio = useP2PCallStore(callOwnsAudio);
  const callDeafened = useP2PCallStore((s) => s.isDeafened);
  const voiceDeafened = useVoiceStore((s) => s.isDeafened);
  return callHasAudio ? callDeafened : voiceDeafened;
}

/** Channel voice's mute toggle, sent to the call instead while an answered call owns the audio. */
export function useToggleActiveMute(toggleVoiceMute: () => void): () => void {
  return useCallback(() => {
    const call = useP2PCallStore.getState();
    if (callOwnsAudio(call)) call.toggleMute();
    else toggleVoiceMute();
  }, [toggleVoiceMute]);
}

/** Channel voice's deafen toggle, sent to the call instead while an answered call owns the audio. */
export function useToggleActiveDeafen(toggleVoiceDeafen: () => void): () => void {
  return useCallback(() => {
    const call = useP2PCallStore.getState();
    if (callOwnsAudio(call)) call.toggleDeafen();
    else toggleVoiceDeafen();
  }, [toggleVoiceDeafen]);
}
