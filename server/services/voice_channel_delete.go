// Package services — closing the call of a voice channel that is being deleted.
package services

// BeginChannelDelete hides channelID's call from every audience decided from now on, before its row
// and overrides go (see markDeleted).
func (s *voiceService) BeginChannelDelete(_, channelID string) {
	s.egress.markDeleted(channelID)
}

// AbortChannelDelete follows a delete that failed: the call is visible again, and what its viewers
// missed while it was hidden is replaced in.
func (s *voiceService) AbortChannelDelete(serverID, channelID string) {
	s.egress.unmarkDeleted(channelID)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if serverID == "" || s.countInChannelLocked(channelID) == 0 {
		return
	}
	s.egress.replaceServer(serverID, nil, s.serverSnapshotLocked(serverID))
}

// FinishChannelDelete takes everyone out of the deleted channel: state, LiveKit, timer. The leaves
// reach only its participants, so every other member shown the call gets their view of the server
// replaced — sent even when the server is now empty, or they keep the call.
func (s *voiceService) FinishChannelDelete(serverID, channelID string) {
	s.egress.markDeleted(channelID) // from the end of the delete, which may have taken a while
	closed := false
	// From this channel only: a participant who moved since the listing is in another call now.
	for _, p := range s.GetChannelParticipants(channelID) {
		if s.DisconnectUserFromChannel(p.UserID, channelID) {
			closed = true
		}
	}
	if !closed || serverID == "" {
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.egress.replaceServer(serverID, nil, s.serverSnapshotLocked(serverID))
}
