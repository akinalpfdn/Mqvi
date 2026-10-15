type RemoteVideoInputs = { remoteTrackVideo: boolean; peerVideoOff: boolean };

/** hasRemoteVideo is only ever written through this, so the two inputs cannot drift apart. */
export function remoteVideo(
  current: RemoteVideoInputs,
  patch: Partial<RemoteVideoInputs>,
): RemoteVideoInputs & { hasRemoteVideo: boolean } {
  const next = { ...current, ...patch };
  return { ...next, hasRemoteVideo: next.remoteTrackVideo && !next.peerVideoOff };
}
