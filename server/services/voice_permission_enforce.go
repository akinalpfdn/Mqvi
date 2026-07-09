// Package services — live mid-call voice permission enforcement (S3).
//
// ConnectVoice/Speak are checked at token generation, but tokens live 24h, so revoking a
// connected user's permission had no effect until they left. These hooks re-apply effective
// permissions at the SFU for users already in voice when a channel override, role, or a
// member's roles change. All entry points are fire-and-forget (call via `go`): they do
// LiveKit network I/O and must never hold s.mu.
package services

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

const voicePermEnforceTimeout = 15 * time.Second

// EnforceChannelVoicePermissions re-checks every participant of one channel — used after a
// channel-override change (affects only users of that channel).
func (s *voiceService) EnforceChannelVoicePermissions(channelID string) {
	for _, p := range s.GetChannelParticipants(channelID) {
		s.enforceVoicePermissionForParticipant(p)
	}
}

// EnforceServerVoicePermissions re-checks every voice participant across a server — used
// after a role's permissions change or a role is deleted (affects all channels).
func (s *voiceService) EnforceServerVoicePermissions(serverID string) {
	for _, p := range s.GetServerParticipants(serverID) {
		s.enforceVoicePermissionForParticipant(p)
	}
}

// EnforceUserVoicePermissions re-checks one user — used after their role assignments change.
// No-op if the user isn't currently in voice.
func (s *voiceService) EnforceUserVoicePermissions(userID string) {
	state := s.GetUserVoiceState(userID)
	if state == nil {
		return
	}
	s.enforceVoicePermissionForParticipant(*state)
}

// currentServerMuteState reads a user's live server-mute flag under RLock (released before
// any I/O). Returns stillInVoice=false if they left voice since the enumeration snapshot.
func (s *voiceService) currentServerMuteState(userID string) (muted bool, stillInVoice bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[userID]
	if !ok {
		return false, false
	}
	return st.IsServerMuted, true
}

// enforceVoicePermissionForParticipant re-resolves a participant's effective channel
// permissions (bypassing the cache, since role/member changes don't invalidate it) and
// applies them at the SFU: no ConnectVoice → disconnect entirely; otherwise re-assert the
// publish permission (Speak-gated), preserving any active server-mute. Best-effort.
// Each participant gets its own timeout ctx so a large server can't let a shared ctx expire
// mid-loop and silently skip the tail. Does LiveKit I/O — MUST NOT be called holding s.mu.
func (s *voiceService) enforceVoicePermissionForParticipant(p models.VoiceState) {
	ctx, cancel := context.WithTimeout(context.Background(), voicePermEnforceTimeout)
	defer cancel()

	perms, err := s.permResolver.ResolveChannelPermissionsFresh(ctx, p.UserID, p.ChannelID)
	if err != nil {
		s.logError(models.LogCategoryVoice, &p.UserID, "voicePermEnforce: permission resolve failed", map[string]string{
			"channel_id": p.ChannelID, "error": err.Error(),
		})
		return
	}

	if !perms.Has(models.PermConnectVoice) {
		// Lost the right to be in voice at all — disconnect (in-memory + LiveKit + broadcast).
		// The fresh resolve above also blocks an immediate rejoin (GenerateToken re-checks
		// ConnectVoice against the now-fresh cache). Tell the target's own client to tear its
		// LiveKit session down cleanly (same signal as an admin force-disconnect).
		s.DisconnectUser(p.UserID)
		s.hub.BroadcastToUser(p.UserID, ws.Event{Op: ws.OpVoiceForceDisconnect})
		return
	}

	// Retains ConnectVoice — re-assert publish. Read the CURRENT server-mute flag (not the
	// snapshot p.IsServerMuted): a server-mute an admin applied after the snapshot must not
	// be clobbered by re-asserting publish with a stale value. Skip if they left voice.
	muted, stillIn := s.currentServerMuteState(p.UserID)
	if !stillIn {
		return
	}
	// Speak gates the mic; an active server-mute still removes the mic on top
	// (buildServerMutePermission handles both).
	s.enforceServerMicMuteAtSFU(p.ServerID, p.ChannelID, p.UserID, muted, perms.Has(models.PermSpeak))
}
