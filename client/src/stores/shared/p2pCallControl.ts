// Lets voiceStore and authStore end the p2p call without importing it (that would be a cycle).

type P2PCallControl = {
  /** A call is up with its media running — the microphone and the audio session are in use. */
  hasLiveMedia(): boolean;
  /** Any call at all, ringing included. */
  hasCall(): boolean;
  end(): void;
  /** Hangs up what this app is in; an incoming call it never answered is only dropped here. */
  leave(): void;
};

let control: P2PCallControl | null = null;

export function registerP2PCallControl(c: P2PCallControl): void {
  control = c;
}

/** Channel voice and a p2p call cannot share the audio session. A ringing call has no media yet. */
export function endP2PCallForVoice(): void {
  if (control?.hasLiveMedia()) control.end();
}

/** Signing out must not leave a call running with no screen to end it from. */
export function endP2PCallForLogout(): void {
  if (control?.hasCall()) control.leave();
}
