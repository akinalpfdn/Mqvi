// The p2p call as other stores need to see it. p2pCallStore registers itself here, and voiceStore
// and authStore reach it through this instead of importing it: voiceStore → p2pCallStore →
// authStore → voiceStore would be an import cycle.

type P2PCallControl = {
  /** A call is up with its media running — the microphone and the audio session are in use. */
  hasLiveMedia(): boolean;
  /** Any call at all, ringing included. */
  hasCall(): boolean;
  end(): void;
};

let control: P2PCallControl | null = null;

export function registerP2PCallControl(c: P2PCallControl): void {
  control = c;
}

/**
 * A voice channel and a p2p call cannot share the audio session — on iOS both run natively
 * against it, and whichever finished last shut it down under the other. Starting a call already
 * leaves the channel; this is the other direction. A call still ringing is left alone: it has
 * no media yet, and accepting it later leaves the channel.
 */
export function endP2PCallForVoice(): void {
  if (control?.hasLiveMedia()) control.end();
}

/** Signing out must not leave a call running with no screen to end it from. */
export function endP2PCallForLogout(): void {
  if (control?.hasCall()) control.end();
}
