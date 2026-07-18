// Package services — admin voice operations: server mute/deafen, move, disconnect.
// All paths resolve channel permissions (PermMuteMembers / PermDeafenMembers /
// PermMoveMembers) before mutating state.
package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"

	livekit "github.com/livekit/protocol/livekit"
)

// AdminUpdateState applies server-level mute/deafen to a user.
// Requires PermMuteMembers / PermDeafenMembers on the target's channel.
func (s *voiceService) AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error {
	// Snapshot the target's channel under a brief lock. No DB I/O here — the permission
	// resolve below hits the DB and must NOT run under s.mu (the global voice lock), or every
	// join/leave/state-update across all servers stalls behind it on a cold cache.
	s.mu.Lock()
	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}
	channelID := state.ChannelID
	s.mu.Unlock()

	// Authorize the admin against the target's channel OUTSIDE the lock.
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, adminUserID, channelID)
	if err != nil {
		s.logError(models.LogCategoryVoice, &adminUserID, "AdminUpdateState: permission resolve failed", map[string]string{
			"target_user": targetUserID, "channel_id": channelID, "error": err.Error(),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if isServerMuted != nil && !effectivePerms.Has(models.PermMuteMembers) {
		return fmt.Errorf("%w: mute members permission required", pkg.ErrForbidden)
	}
	if isServerDeafened != nil && !effectivePerms.Has(models.PermDeafenMembers) {
		return fmt.Errorf("%w: deafen members permission required", pkg.ErrForbidden)
	}

	// Re-lock and mutate. Re-verify the target is still in the SAME channel we authorized
	// against — if they left or moved between the snapshot and now, abort (admin can retry).
	s.mu.Lock()
	state, ok = s.states[targetUserID]
	if !ok || state.ChannelID != channelID {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	if isServerMuted != nil {
		state.IsServerMuted = *isServerMuted
	}
	if isServerDeafened != nil {
		state.IsServerDeafened = *isServerDeafened
	}

	// Snapshot for use after unlock (broadcast payload + SFU enforcement).
	serverID := state.ServerID
	newServerMuted := state.IsServerMuted
	muteChanged := isServerMuted != nil
	broadcast := ws.VoiceStateUpdateBroadcast{
		UserID:           state.UserID,
		ChannelID:        state.ChannelID,
		Username:         state.Username,
		DisplayName:      state.DisplayName,
		AvatarURL:        s.urlSigner.SignURL(state.AvatarURL),
		IsMuted:          state.IsMuted,
		IsDeafened:       state.IsDeafened,
		IsStreaming:      state.IsStreaming,
		ShareQuality:     state.ShareQuality,
		IsServerMuted:    state.IsServerMuted,
		IsServerDeafened: state.IsServerDeafened,
		Action:           "update",
	}

	s.mu.Unlock()

	// Enforce server-mute at the SFU (only mute is SFU-enforceable; deafen stays
	// client-side). Runs BEFORE the broadcast so on unmute the mic-publish permission is
	// restored before the honest client (reacting to the broadcast) tries to republish.
	// LiveKit network I/O is outside s.mu.
	if muteChanged {
		// Fresh resolve (not cached): a role/override change that just revoked the target's
		// Speak may not have invalidated the cache, and re-asserting publish off a stale
		// Speak would clobber the live permission enforcement (Phase 46).
		targetPerms, permErr := s.permResolver.ResolveChannelPermissionsFresh(ctx, targetUserID, channelID)
		if permErr != nil {
			// Can't determine the target's publish baseline — skip SFU enforcement rather
			// than risk locking out (unmute) or over-granting (mute). Falls back to the
			// flag broadcast, which honest clients still honor.
			s.logError(models.LogCategoryVoice, &targetUserID, "AdminUpdateState: target permission resolve failed; SFU mute enforcement skipped", map[string]string{
				"channel_id": channelID, "error": permErr.Error(),
			})
		} else {
			s.enforceServerMicMuteAtSFU(serverID, channelID, targetUserID, newServerMuted, targetPerms.Has(models.PermSpeak))
		}
	}

	s.broadcastToServer(serverID, ws.Event{Op: ws.OpVoiceStateUpdate, Data: broadcast})

	log.Printf("[voice] admin %s updated server state for user %s (muted=%v, deafened=%v)",
		adminUserID, targetUserID, broadcast.IsServerMuted, broadcast.IsServerDeafened)
	return nil
}

// buildServerMutePermission returns the LiveKit participant permission for a server-mute
// state change. Server-mute revokes only the MICROPHONE publish source — camera and screen
// share stay publishable (Discord-style: mute is audio-only). Gated on canSpeak so muting
// never grants publish to a user who couldn't publish. Subscribe stays enabled; server-
// deafen is client-side, not SFU-enforced.
// serverMuteAllowedSources is every publishable source EXCEPT microphone — the allow-list
// applied to a server-muted user (audio-only mute; camera + screen share stay publishable).
// Shared by the live SFU enforcement (buildServerMutePermission) and the token baking in
// GenerateToken so both stay in lockstep.
func serverMuteAllowedSources() []livekit.TrackSource {
	return []livekit.TrackSource{
		livekit.TrackSource_CAMERA,
		livekit.TrackSource_SCREEN_SHARE,
		livekit.TrackSource_SCREEN_SHARE_AUDIO,
	}
}

func buildServerMutePermission(muted, canSpeak bool) *livekit.ParticipantPermission {
	perm := &livekit.ParticipantPermission{
		CanSubscribe:   true,
		CanPublish:     canSpeak,
		CanPublishData: true,
	}
	// CanPublishSources supersedes CanPublish: allow every source EXCEPT microphone.
	if muted && canSpeak {
		perm.CanPublishSources = serverMuteAllowedSources()
	}
	return perm
}

// Server-mute is a security control ("can't be bypassed"), so a transient SFU error must
// not silently leave a muted user publishing. We retry the UpdateParticipant a bounded
// number of times; a "not found" (participant not in the SFU) is NOT retried — reconnect
// re-enforces it via the token bake (GenerateToken).
const (
	sfuMuteMaxAttempts = 3
	sfuMuteRetryDelay  = 250 * time.Millisecond
)

// enforceServerMicMuteAtSFU applies (or lifts) a server-mute at the SFU by updating the
// participant's publish permission. A non-cooperating client cannot bypass it: revoking
// the microphone source unpublishes any live mic track and blocks republishing.
// Best-effort with bounded retry: errors are logged, not propagated. MUST NOT be called under mu.Lock.
func (s *voiceService) enforceServerMicMuteAtSFU(serverID, channelID, userID string, muted, canSpeak bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	roomClient, err := s.newLiveKitRoomClient(ctx, serverID)
	if err != nil {
		log.Printf("[voice] serverMute: room client init failed for server %s: %v", serverID, err)
		s.logError(models.LogCategoryVoice, &userID, "serverMute: room client init failed", map[string]string{
			"server_id": serverID, "channel_id": channelID, "error": err.Error(),
		})
		return
	}

	roomName := serverID + ":" + channelID
	req := &livekit.UpdateParticipantRequest{
		Room:       roomName,
		Identity:   userID,
		Permission: buildServerMutePermission(muted, canSpeak),
	}

	for attempt := 1; attempt <= sfuMuteMaxAttempts; attempt++ {
		_, err = roomClient.UpdateParticipant(ctx, req)
		if err == nil {
			log.Printf("[voice] serverMute: user=%s room=%s micMuted=%v enforced at SFU", userID, roomName, muted)
			return
		}
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			// Participant not connected to the SFU (e.g. WS-joined but LiveKit not up yet).
			// Not retryable; a reconnect re-enforces via the token bake.
			log.Printf("[voice] serverMute: user=%s room=%s not in SFU (not found)", userID, roomName)
			s.logWarn(models.LogCategoryVoice, &userID, "serverMute: participant not in SFU", map[string]string{
				"room": roomName, "channel_id": channelID, "muted": fmt.Sprintf("%v", muted), "error": err.Error(),
			})
			return
		}
		if attempt < sfuMuteMaxAttempts {
			time.Sleep(sfuMuteRetryDelay)
		}
	}

	// All attempts failed on a transient error: the mute flag/broadcast say muted but the
	// SFU may still let the mic through until the user reconnects (token bake). Log loudly.
	log.Printf("[voice] serverMute: user=%s room=%s FAILED after %d attempts — mic-mute NOT enforced at SFU: %v", userID, roomName, sfuMuteMaxAttempts, err)
	s.logError(models.LogCategoryVoice, &userID, "serverMute: LiveKit UpdateParticipant failed after retries", map[string]string{
		"room": roomName, "channel_id": channelID, "muted": fmt.Sprintf("%v", muted), "attempts": fmt.Sprintf("%d", sfuMuteMaxAttempts), "error": err.Error(),
	})
}

// MoveUser moves a user between voice channels.
// Requires PermMoveMembers in both source and target channels (or ConnectVoice for self-move).
func (s *voiceService) MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error {
	channel, err := s.channelGetter.GetByID(ctx, targetChannelID)
	if err != nil {
		return fmt.Errorf("%w: target channel not found", pkg.ErrNotFound)
	}
	if channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: target is not a voice channel", pkg.ErrBadRequest)
	}

	// Snapshot the source channel under a brief lock; resolve permissions OUTSIDE the lock
	// (DB I/O must not run under s.mu — it stalls all-server voice state mutations).
	s.mu.Lock()
	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}
	sourceChannelID := state.ChannelID
	s.mu.Unlock()

	if sourceChannelID == targetChannelID {
		return fmt.Errorf("%w: user is already in that channel", pkg.ErrBadRequest)
	}

	isSelfMove := moverUserID == targetUserID

	if isSelfMove {
		// Self-move: only need ConnectVoice in target channel (no MoveMembers required)
		targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
		if err != nil {
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
	} else {
		// Moving another user: require PermMoveMembers in both channels
		sourcePerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, sourceChannelID)
		if err != nil {
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: source channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "source_channel": sourceChannelID, "error": err.Error(),
			})
			return fmt.Errorf("failed to resolve source channel permissions: %w", err)
		}
		if !sourcePerms.Has(models.PermMoveMembers) {
			return fmt.Errorf("%w: move members permission required in source channel", pkg.ErrForbidden)
		}

		targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
		if err != nil {
			s.logError(models.LogCategoryVoice, &moverUserID, "MoveUser: target channel permission resolve failed", map[string]string{
				"target_user": targetUserID, "target_channel": targetChannelID, "error": err.Error(),
			})
			return fmt.Errorf("failed to resolve target channel permissions: %w", err)
		}
		if !targetPerms.Has(models.PermMoveMembers) {
			return fmt.Errorf("%w: move members permission required in target channel", pkg.ErrForbidden)
		}
		if !targetPerms.Has(models.PermConnectVoice) {
			return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
		}
	}

	// Re-lock and mutate. Re-verify the target is still in the SAME source channel we
	// authorized against — if they left or moved meanwhile, abort (mover can retry).
	s.mu.Lock()
	state, ok = s.states[targetUserID]
	if !ok || state.ChannelID != sourceChannelID {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	sourceServerID := state.ServerID
	targetServerID := channel.ServerID

	// Capture before reassignment to detect the target's 0 → 1 transition.
	targetWasEmpty := s.countInChannelLocked(targetChannelID) == 0

	state.ChannelID = targetChannelID
	state.ChannelName = channel.Name
	state.ServerID = targetServerID
	delete(s.livekitAbsentSince, targetUserID) // new room — reset LiveKit absence grace

	s.cleanupRoomPassphraseIfEmpty(sourceChannelID)

	// Broadcast leave(source) + join(target). If both channels are on the same
	// server, one BroadcastToServer covers both events' audiences.
	signedAvatar := s.urlSigner.SignURL(state.AvatarURL)
	s.broadcastToServer(sourceServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        sourceChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        signedAvatar,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "leave",
		},
	})
	s.broadcastToServer(targetServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        targetChannelID,
			ChannelName:      channel.Name,
			ServerID:         targetServerID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        signedAvatar,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			ShareQuality:     state.ShareQuality,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "join",
		},
	})

	// Timer transitions AFTER the state-update broadcasts — matches the
	// state-update-then-timer ordering of JoinChannel/LeaveChannel so clients
	// process the move (and any ephemeral-chat wipe) before the timer changes.
	if s.countInChannelLocked(sourceChannelID) == 0 {
		s.stopChannelTimerLocked(sourceChannelID, sourceServerID)
	}
	if targetWasEmpty {
		s.startChannelTimerLocked(targetChannelID, targetServerID, time.Now())
	}

	// Grant one-time permission bypass so the moved user can generate a token
	// for the target channel even without ConnectVoice permission.
	s.forceMoveGrants[targetUserID] = forceMoveGrant{
		channelID: targetChannelID,
		expiresAt: time.Now().Add(30 * time.Second),
	}

	s.mu.Unlock()

	// Tell client to switch LiveKit rooms
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op:   ws.OpVoiceForceMove,
		Data: ws.VoiceForceMoveData{ChannelID: targetChannelID},
	})

	// Remove phantom from old LiveKit room (best-effort)
	go s.removeParticipantFromLiveKit(sourceServerID, sourceChannelID, targetUserID)

	log.Printf("[voice] user %s moved user %s from channel %s to %s",
		moverUserID, targetUserID, sourceChannelID, targetChannelID)
	return nil
}

// AdminDisconnectUser force-disconnects a user from voice.
// Requires PermMoveMembers in the target's current channel (same as Discord).
func (s *voiceService) AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error {
	s.mu.Lock()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, disconnecterUserID, state.ChannelID)
	if err != nil {
		s.mu.Unlock()
		s.logError(models.LogCategoryVoice, &disconnecterUserID, "AdminDisconnectUser: permission resolve failed", map[string]string{
			"target_user": targetUserID, "channel_id": state.ChannelID, "error": err.Error(),
		})
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if !effectivePerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required", pkg.ErrForbidden)
	}

	channelID := state.ChannelID
	serverID := state.ServerID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := s.urlSigner.SignURL(state.AvatarURL)
	delete(s.states, targetUserID)
	delete(s.livekitAbsentSince, targetUserID)

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      targetUserID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	// Stop the channel's call timer if this disconnect emptied it — same as
	// LeaveChannel. Without this, an admin disconnect of the last user leaves the
	// timer running forever (the 120h stale-timer bug via the admin path).
	if s.countInChannelLocked(channelID) == 0 {
		s.stopChannelTimerLocked(channelID, serverID)
	}

	s.cleanupRoomPassphraseIfEmpty(channelID)

	s.mu.Unlock()

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpVoiceForceDisconnect,
	})

	go s.removeParticipantFromLiveKit(serverID, channelID, targetUserID)

	log.Printf("[voice] admin %s disconnected user %s from channel %s",
		disconnecterUserID, targetUserID, channelID)
	return nil
}
