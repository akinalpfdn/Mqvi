// Package services — voice state as a member may see it.
//
// A member sees the participants of the voice channels they can view, and of the channel they are
// in. The snapshots here (ready sync, GET /voice/states) and the resyncs after a permission change
// apply the same rule the egress applies to live events.
package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ResyncChannelVisibility follows a change to channelID's overrides. Only that channel's audience
// changed, but the client replaces voice state per server, so the server's members are resent it.
// A channel with nobody in it changes nothing anyone holds.
func (s *voiceService) ResyncChannelVisibility(serverID, channelID string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if serverID == "" || s.countInChannelLocked(channelID) == 0 {
		return
	}
	s.egress.replaceServer(serverID, nil, s.serverSnapshotLocked(serverID))
}

// ResyncServerVisibility follows a role permission change or a role deletion.
func (s *voiceService) ResyncServerVisibility(serverID string) {
	s.resyncServer(serverID, nil)
}

// ResyncUserVisibility follows a change to one member's roles.
func (s *voiceService) ResyncUserVisibility(serverID, userID string) {
	s.resyncServer(serverID, []string{userID})
}

// resyncServer queues the snapshot under the lock, so it takes its place in the server's event
// order: everything before it is reflected in it, everything after it is delivered after it.
func (s *voiceService) resyncServer(serverID string, users []string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if serverID == "" {
		return
	}
	snap := s.serverSnapshotLocked(serverID)
	if len(snap.states) == 0 {
		return
	}
	s.egress.replaceServer(serverID, users, snap)
}

// retryResync is the egress's next try after a failed audience read: a fresh snapshot, queued in
// order like any resync. Sent even when the server is now empty, because the failed delivery may
// have left members holding a participant who has since left.
func (s *voiceService) retryResync(serverID string, users []string, attempt int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.egress.replaceServerAttempt(serverID, users, s.serverSnapshotLocked(serverID), attempt)
}

// VisibleVoiceStates returns the voice state of serverIDs that userID may see, and the timers of
// those channels. One visibility read per server; a failed read leaves that server with only the
// user's own channel, and a resync follows.
func (s *voiceService) VisibleVoiceStates(ctx context.Context, userID string, serverIDs []string) ([]models.VoiceState, map[string]int64) {
	snaps := make(map[string]voiceSnapshot, len(serverIDs))
	s.mu.RLock()
	for _, serverID := range serverIDs {
		if _, done := snaps[serverID]; done {
			continue
		}
		if snap := s.serverSnapshotLocked(serverID); len(snap.states) > 0 {
			snaps[serverID] = snap
		}
	}
	s.mu.RUnlock()

	states := make([]models.VoiceState, 0)
	timers := make(map[string]int64)
	for serverID, snap := range snaps {
		vis := s.egress.userVisibility(ctx, userID, serverID, snap)
		if vis.failed {
			s.egress.retryLater(serverID, []string{userID}, 0)
		}
		sees := vis.sees
		for _, st := range snap.states {
			if !sees(st.ChannelID) {
				continue
			}
			states = append(states, st)
			if t, ok := snap.timers[st.ChannelID]; ok {
				timers[st.ChannelID] = t
			}
		}
	}
	return states, timers
}
