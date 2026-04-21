// Tab-scoped flag for F5/reload voice recovery. Set when user joins voice,
// cleared on explicit leave. sessionStorage is tab-local — new tabs/windows
// start empty, which is what we want: only the SAME tab that was in voice
// should auto-recover after F5. A fresh tab must never claim voice on its own.
export const VOICE_RECOVERY_KEY = "mqvi_voice_recovery_channel";

export function markVoiceActive(channelId: string): void {
  try {
    sessionStorage.setItem(VOICE_RECOVERY_KEY, channelId);
  } catch {
    /* ignore */
  }
}

export function clearVoiceRecoveryMark(): void {
  try {
    sessionStorage.removeItem(VOICE_RECOVERY_KEY);
  } catch {
    /* ignore */
  }
}

export function isVoiceRecoveryAllowed(channelId: string): boolean {
  try {
    return sessionStorage.getItem(VOICE_RECOVERY_KEY) === channelId;
  } catch {
    return false;
  }
}
