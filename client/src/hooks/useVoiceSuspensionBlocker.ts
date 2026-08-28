/**
 * useVoiceSuspensionBlocker — asks Electron to keep the OS from suspending the app while the user
 * is in a voice channel.
 *
 * Electron-only and mounted app-wide rather than inside the voice provider: the provider unmounts
 * on disconnect, and the block has to be released on exactly that transition. Watching the store
 * from a component that is always alive means the two edges cannot be missed.
 *
 * Complements the occlusion switches in the main process, which stop Chromium from backgrounding
 * the renderer. This covers the other half on macOS, where App Nap can demote the whole app.
 */

import { useEffect } from "react";
import { useVoiceStore } from "../stores/voiceStore";

export function useVoiceSuspensionBlocker(): void {
  // Keyed on the boolean, not the channel id: moving between channels is not a change in whether a
  // call is in progress, and keying on the id stopped and restarted the blocker on every hop.
  // Same derivation as UserBar, so there is one answer to "is this user in voice" rather than two.
  const isInVoice = useVoiceStore((s) => s.currentVoiceChannelId !== null);

  useEffect(() => {
    const setVoiceActive = window.electronAPI?.setVoiceActive;
    if (!setVoiceActive) return;

    // Asserts the current state on every run, including the false case that the cleanup below has
    // usually just sent. That redundancy is load-bearing, not sloppiness: a renderer reload skips
    // the cleanup entirely and leaves the main process holding a blocker nobody will release, and
    // this mount-time assert is what frees it. Do not "optimise" it into a rising-edge-only call.
    void setVoiceActive(isInVoice);

    // Released on unmount too: an app torn down mid-call must not leave the blocker held.
    return () => {
      if (isInVoice) void setVoiceActive(false);
    };
  }, [isInVoice]);
}
