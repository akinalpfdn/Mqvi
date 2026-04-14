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
				AvatarURL:        avatarURL,
				IsServerMuted:    existing.IsServerMuted,
				IsServerDeafened: existing.IsServerDeafened,
				Action:           "leave",
			},
		})

		s.cleanupRoomPassphraseIfEmpty(oldChannelID)
	}

	s.states[userID] = &models.VoiceState{
		UserID:       userID,
		ChannelID:    channelID,
		ServerID:     serverID,
		Username:     username,
		DisplayName:  displayName,
		AvatarURL:    avatarURL,
		IsMuted:      isMuted,
		IsDeafened:   isDeafened,
		LastActivity: time.Now(),
	}

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			IsMuted:     isMuted,
			IsDeafened:  isDeafened,
			Action:      "join",
		},
	})

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
	avatarURL := state.AvatarURL
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
			AvatarURL:        state.AvatarURL,
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
