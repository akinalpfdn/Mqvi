// Lets voiceStore and authStore end the p2p call without importing it (that would be a cycle).

type P2PCallControl = {
  /** Any call that owns, or is about to own, the microphone and the audio session. */
  hasLiveMedia(): boolean;
  /** Any call at all, ringing included. */
  hasCall(): boolean;
  ready(): Promise<void>;
  end(): void | Promise<boolean>;
  /** Hangs up what this app is in; an incoming call it never answered is only dropped here. */
  leave(): void;
};

let control: P2PCallControl | null = null;

export function registerP2PCallControl(c: P2PCallControl): void {
  control = c;
}

/**
 * Channel voice and a p2p call cannot share the iOS audio session. A ringing call counts too: it
 * takes the session the moment the other side answers, with nothing left to stop it.
 */
export async function endP2PCallForVoice(): Promise<boolean> {
  await control?.ready();
  return !control?.hasLiveMedia() || (await control.end()) !== false;
}

/** Signing out must not leave a call running with no screen to end it from. */
export function endP2PCallForLogout(): void {
  if (control?.hasCall()) control.leave();
}
