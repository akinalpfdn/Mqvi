// Package services — voice channel join/leave/update and state queries.
// Owns the central `states` map lifecycle; all mutations happen here or in
// voice_admin.go. Lock discipline: every state mutation is bracketed by s.mu.
package services

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// broadcastToServer publishes a voice-related event to all members of serverID.
// No-op on empty serverID (e.g. channel lookup failed) so malformed state can't
// leak broadcasts to the wrong audience.
func (s *voiceService) broadcastToServer(serverID string, event ws.Event) {
	if serverID == "" {
		return
	}
	s.hub.BroadcastToServer(serverID, event)
}

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error {
	// avatarURL is the raw, unsigned URL from the DB. We store it unsigned in
	// VoiceState (which lives as long as the user is in voice — could be hours)
	// and re-sign at every broadcast egress. Storing an already-signed URL would
	// expire mid-session and serve 401s to anyone who joined later via voice_states_sync.
	signedAvatar := s.urlSigner.SignURL(avatarURL)

	// Resolve channel's parent server before locking — all voice broadcasts are server-scoped.
	channel, err := s.channelGetter.GetByID(context.Background(), channelID)
	if err != nil {
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	serverID := channel.ServerID

	var oldChannelID string
	var oldServerID string

	s.mu.Lock()

	// Leave current channel if in one
	if existing, ok := s.states[userID]; ok {
		oldChannelID = existing.ChannelID
		oldServerID = existing.ServerID

		// Same-channel rejoin (WS reconnect) — silently refresh state, no broadcast.
		// This prevents false leave/join sounds for everyone in the channel.
		if oldChannelID == channelID {
			existing.Username = username
			existing.DisplayName = displayName
			existing.AvatarURL = avatarURL
			existing.LastActivity = time.Now()
			s.mu.Unlock()
			log.Printf("[voice] same-channel rejoin user=%s channel=%s (no broadcast)", userID, channelID)
			return nil
		}

		delete(s.states, userID)

		s.broadcastToServer(oldServerID, ws.Event{
			Op: ws.OpVoiceStateUpdate,
			Data: ws.VoiceStateUpdateBroadcast{
				UserID:           userID,
				ChannelID:        oldChannelID,
				Username:         username,
				DisplayName:      displayName,
				AvatarURL:        signedAvatar,
				IsServerMuted:    existing.IsServerMuted,
				IsServerDeafened: existing.IsServerDeafened,
				Action:           "leave",
			},
		})

		if s.countInChannelLocked(oldChannelID) == 0 {
			s.stopChannelTimerLocked(oldChannelID, oldServerID)
		}

		s.cleanupRoomPassphraseIfEmpty(oldChannelID)
	}

	// Capture before insertion so we can detect the 0 → 1 transition.
	newChannelWasEmpty := s.countInChannelLocked(channelID) == 0

	s.states[userID] = &models.VoiceState{
		UserID:       userID,
		ChannelID:    channelID,
		ChannelName:  channel.Name,
		ServerID:     serverID,
		Username:     username,
		DisplayName:  displayName,
		AvatarURL:    avatarURL, // unsigned — see comment above
		IsMuted:      isMuted,
		IsDeafened:   isDeafened,
		LastActivity: time.Now(),
	}

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			ChannelName: channel.Name,
			ServerID:    serverID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   signedAvatar,
			IsMuted:     isMuted,
			IsDeafened:  isDeafened,
			Action:      "join",
		},
	})

	if newChannelWasEmpty {
		s.startChannelTimerLocked(channelID, serverID, time.Now())
	}

	s.mu.Unlock()

	// Remove phantom participant from old LiveKit room (best-effort, outside lock)
	if oldChannelID != "" && oldChannelID != channelID {
		go s.removeParticipantFromLiveKit(oldChannelID, userID)
	}

	log.Printf("[voice] user %s joined channel %s", userID, channelID)
	return nil
}

func (s *voiceService) LeaveChannel(userID string) error {
	s.mu.Lock()

	state, ok := s.states[userID]
	if !ok {
		s.mu.Unlock()
		return nil
	}

	channelID := state.ChannelID
	serverID := state.ServerID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := s.urlSigner.SignURL(state.AvatarURL)
	wasStreaming := state.IsStreaming
	delete(s.states, userID)

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Action:      "leave",
		},
	})

	// Clean up screen share viewer tracking for the leaving user
	if wasStreaming {
		// User was streaming — clear their viewer set and broadcast final update
		delete(s.screenShareViewers, userID)
		s.broadcastToServer(serverID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      channelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		})
	}
	// User was a viewer — remove from all streamer viewer sets
	for streamerID, viewers := range s.screenShareViewers {
		if viewers[userID] {
			delete(viewers, userID)
			viewerCount := len(viewers)
			if viewerCount == 0 {
				delete(s.screenShareViewers, streamerID)
			}
			// Find streamer's channel for broadcast
			if streamerState, ok := s.states[streamerID]; ok {
				s.broadcastToServer(streamerState.ServerID, ws.Event{
					Op: ws.OpScreenShareViewerUpdate,
					Data: ws.ScreenShareViewerUpdateData{
						StreamerUserID: streamerID,
						ChannelID:      streamerState.ChannelID,
						ViewerCount:    viewerCount,
						ViewerUserID:   userID,
						Action:         "leave",
					},
				})
			}
		}
	}

	if s.countInChannelLocked(channelID) == 0 {
		s.stopChannelTimerLocked(channelID, serverID)
	}

	// Clean up E2EE passphrase if room is empty (forward secrecy)
	s.cleanupRoomPassphraseIfEmpty(channelID)

	s.mu.Unlock()

	// Remove from LiveKit (best-effort, outside lock — involves DB calls)
	go s.removeParticipantFromLiveKit(channelID, userID)

	log.Printf("[voice] user %s left channel %s", userID, channelID)
	return nil
}

func (s *voiceService) UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return nil
	}

	wasStreaming := state.IsStreaming

	if maxScreenShares > 0 && isStreaming != nil && *isStreaming {
		count := 0
		for _, st := range s.states {
			if st.ChannelID == state.ChannelID && st.IsStreaming && st.UserID != userID {
				count++
			}
		}
		if count >= maxScreenShares {
			return fmt.Errorf("%w: maximum screen shares reached", pkg.ErrBadRequest)
		}
	}

	if isMuted != nil {
		state.IsMuted = *isMuted
	}
	if isDeafened != nil {
		state.IsDeafened = *isDeafened
	}
	if isStreaming != nil {
		state.IsStreaming = *isStreaming
	}

	s.broadcastToServer(state.ServerID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        state.ChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        s.urlSigner.SignURL(state.AvatarURL),
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "update",
		},
	})

	// Streamer stopped streaming — clean up viewer tracking and broadcast final update
	if wasStreaming && !state.IsStreaming {
		delete(s.screenShareViewers, userID)
		s.broadcastToServer(state.ServerID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      state.ChannelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		})
	}

	return nil
}

// UpdateUserProfile refreshes the cached profile of a user's active voice state
// after a profile change, so voice_states_sync on reconnect serves the current
// avatar/name instead of a now-deleted old avatar file. No-op if not in voice.
func (s *voiceService) UpdateUserProfile(userID, username, displayName, avatarURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return
	}
	state.Username = username
	state.DisplayName = displayName
	state.AvatarURL = avatarURL // unsigned — signed at broadcast egress
}

// ─── Channel timer helpers (caller holds s.mu) ───

// countInChannelLocked returns the number of users currently in channelID.
func (s *voiceService) countInChannelLocked(channelID string) int {
	n := 0
	for _, st := range s.states {
		if st.ChannelID == channelID {
			n++
		}
	}
	return n
}

// startChannelTimerLocked marks the channel as active and broadcasts the start
// event. No-op if already running.
func (s *voiceService) startChannelTimerLocked(channelID, serverID string, now time.Time) {
	if _, exists := s.channelStartedAt[channelID]; exists {
		return
	}
	s.channelStartedAt[channelID] = now
	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceChannelTimerStart,
		Data: ws.VoiceChannelTimerStartData{
			ChannelID: channelID,
			StartedAt: now.UnixMilli(),
		},
	})
}

// stopChannelTimerLocked clears an active timer and broadcasts the stop event.
// No-op if no timer was running. Also fires the channel-empty callback (async)
// so dependent state — e.g. ephemeral voice chat — can be cleaned up.
func (s *voiceService) stopChannelTimerLocked(channelID, serverID string) {
	if _, exists := s.channelStartedAt[channelID]; !exists {
		return
	}
	delete(s.channelStartedAt, channelID)
	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceChannelTimerStop,
		Data: ws.VoiceChannelTimerStopData{ChannelID: channelID},
	})
	if s.onChannelEmpty != nil {
		go s.onChannelEmpty(channelID)
	}
}

// GetActiveChannelTimers returns a snapshot of active channel start times (Unix ms).
// Used by the WS sync handler to populate clients on reconnect.
func (s *voiceService) GetActiveChannelTimers() map[string]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int64, len(s.channelStartedAt))
	for cid, t := range s.channelStartedAt {
		out[cid] = t.UnixMilli()
	}
	return out
}

// ─── Query Methods ───

func (s *voiceService) GetChannelParticipants(channelID string) []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var participants []models.VoiceState
	for _, state := range s.states {
		if state.ChannelID == channelID {
			participants = append(participants, *state)
		}
	}
	return participants
}

func (s *voiceService) GetUserVoiceState(userID string) *models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if state, ok := s.states[userID]; ok {
		copy := *state
		return &copy
	}
	return nil
}

func (s *voiceService) GetAllVoiceStates() []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	states := make([]models.VoiceState, 0, len(s.states))
	for _, state := range s.states {
		states = append(states, *state)
	}
	return states
}

func (s *voiceService) DisconnectUser(userID string) {
	if err := s.LeaveChannel(userID); err != nil {
		log.Printf("[voice] disconnect cleanup failed for user=%s: %v", userID, err)
	}
}

func (s *voiceService) GetStreamCount(channelID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, state := range s.states {
		if state.ChannelID == channelID && state.IsStreaming {
			count++
		}
	}
	return count
}

func (s *voiceService) GetUserVoiceChannelID(userID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if state, ok := s.states[userID]; ok {
		return state.ChannelID
	}
	return ""
}
