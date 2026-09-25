/**
 * NativeVoiceStateSync — iOS counterpart of VoiceStateManager's volume sync. Voice runs in the
 * native room there, so per-user volume, local mute, master volume and a moderator's deafen reach
 * it through the plugin, as the same gains the page's LiveKit room gets everywhere else.
 */

import { useEffect } from "react";
import { useVoiceStore } from "../../stores/voiceStore";
import { nativeVoiceSetRemoteVolumes } from "../../utils/nativePlugins";
import { remoteAudioGains } from "../../utils/remoteAudioGain";

function NativeVoiceStateSync() {
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);

  useEffect(() => {
    const gains = remoteAudioGains({ userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened });
    nativeVoiceSetRemoteVolumes(gains).catch((err: unknown) => {
      console.error("[NativeVoiceStateSync] setRemoteVolumes failed:", err);
    });
  }, [userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened]);

  return null;
}

export default NativeVoiceStateSync;
