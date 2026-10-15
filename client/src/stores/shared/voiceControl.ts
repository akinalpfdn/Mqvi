// Lets the p2p call store leave channel voice without importing it (that would be a cycle).

let leave: (() => void) | null = null;

export function registerVoiceLeave(fn: (() => void) | null): void {
  leave = fn;
}

/** A call is starting: channel voice must let the audio session go first. */
export function leaveVoiceForCall(): void {
  leave?.();
}
