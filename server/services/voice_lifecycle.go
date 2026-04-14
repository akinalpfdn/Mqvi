// Package services — background voice goroutines and LiveKit cleanup.
// Orphan state sweep handles abandoned WS connections; AFK sweep kicks users
// who have been idle longer than their server's afk_timeout_minutes.
package services

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/ws"

	livekit "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// orphanGracePeriod is the guaranteed minimum time a user must be offline
// before their voice state is cleaned up. Prevents false leave/join broadcasts
// (and sounds) during brief WS reconnects. The old fixed-ticker approach gave
// 0–30s of grace depending on phase alignment; per-user timestamps guarantee
// the full duration regardless of when the disconnect happens.
const orphanGracePeriod = 35 * time.Second

type orphanEntry struct {
	userID    string
	channelID string
}

type afkEntry struct {
	userID      string
	channelID   string
	channelName string
	serverID    string
	serverName  string
}

// UpdateActivity resets the AFK timer for a user (called on mouse/keyboard/VAD/screen share activity).
func (s *voiceService) UpdateActivity(userID string) {
	s.mu.Lock()
	if state, ok := s.states[userID]; ok {
		state.LastActivity = time.Now()
	}
	s.mu.Unlock()
}

// StartOrphanCleanup periodically removes voice states for users who have been
// disconnected longer than orphanGracePeriod. Runs every 5s for responsive
// cleanup after grace expires — per-user timestamps prevent premature removal.
func (s *voiceService) StartOrphanCleanup() {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepOrphanStates()
		}
	}()
}

// sweepOrphanStates uses two-phase per-user tracking:
//  1. First time a user with voice state is seen offline → record offlineSince timestamp
//  2. User comes back online before grace expires → clear tracking, no broadcast
//  3. Grace period expires → broadcast leave, remove state, cleanup LiveKit
//
// This guarantees orphanGracePeriod of grace regardless of ticker phase.
func (s *voiceService) sweepOrphanStates() {
	onlineIDs := s.onlineChecker.GetOnlineUserIDs()
	onlineSet := make(map[string]bool, len(onlineIDs))
	for _, id := range onlineIDs {
		onlineSet[id] = true
	}

	now := time.Now()
	var orphans []orphanEntry

	s.mu.Lock()

	// Phase 1: Track newly offline users, clear returned-online users
	for userID := range s.states {
		if onlineSet[userID] {
			// Back online — clear any pending offline tracking
			delete(s.offlineSince, userID)
		} else if _, tracked := s.offlineSince[userID]; !tracked {
			// First time seeing this user offline — start grace timer
			s.offlineSince[userID] = now
		}
	}

	// Phase 2: Only remove users who exceeded the grace period
	for userID, offlineTime := range s.offlineSince {
		if now.Sub(offlineTime) < orphanGracePeriod {
			continue // Still within grace — do not touch
		}

		state, ok := s.states[userID]
		if !ok {
			// Voice state already removed (explicit leave during grace) — clean tracker
			delete(s.offlineSince, userID)
			continue
		}

		// Grace expired — confirmed abandoned session
		channelID := state.ChannelID
		serverID := state.ServerID
		username := state.Username
		displayName := state.DisplayName
		avatarURL := state.AvatarURL
		delete(s.states, userID)
		delete(s.offlineSince, userID)

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

		s.cleanupRoomPassphraseIfEmpty(channelID)
		orphans = append(orphans, orphanEntry{userID: userID, channelID: channelID})
		log.Printf("[voice] orphan cleanup: removed user %s from channel %s (offline for %s)", userID, channelID, now.Sub(offlineTime).Round(time.Second))
		s.logWarn(models.LogCategoryVoice, &userID, "orphan cleanup: stale voice state removed", map[string]string{
			"channel_id":      channelID,
			"offline_seconds": fmt.Sprintf("%.0f", now.Sub(offlineTime).Seconds()),
		})
	}

	// Clean stale trackers (user left voice explicitly during grace)
	for userID := range s.offlineSince {
		if _, ok := s.states[userID]; !ok {
			delete(s.offlineSince, userID)
		}
	}

	s.mu.Unlock()

	// LiveKit cleanup outside lock (involves DB calls)
	for _, o := range orphans {
		s.removeParticipantFromLiveKit(o.channelID, o.userID)
	}
}

// removeParticipantFromLiveKit explicitly removes a participant from the LiveKit server.
// Without this, phantom participants linger until ICE/DTLS timeout.
// Best-effort: errors are logged but not propagated.
// MUST NOT be called under mu.Lock (does DB lookups).
func (s *voiceService) removeParticipantFromLiveKit(channelID, userID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		log.Printf("[voice] removeParticipant: channel lookup failed for %s: %v", channelID, err)
		s.logError(models.LogCategoryVoice, &userID, "removeParticipant: channel lookup failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		log.Printf("[voice] removeParticipant: livekit instance lookup failed for server %s: %v", channel.ServerID, err)
		s.logError(models.LogCategoryVoice, &userID, "removeParticipant: LiveKit instance lookup failed", map[string]string{
			"server_id": channel.ServerID, "channel_id": channelID, "error": err.Error(),
		})
		return
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		log.Printf("[voice] removeParticipant: api key decrypt failed: %v", err)
		s.logError(models.LogCategoryVoice, &userID, "removeParticipant: API key decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		log.Printf("[voice] removeParticipant: api secret decrypt failed: %v", err)
		s.logError(models.LogCategoryVoice, &userID, "removeParticipant: API secret decrypt failed", map[string]string{
			"channel_id": channelID, "error": err.Error(),
		})
		return
	}

	roomName := channel.ServerID + ":" + channelID
	roomClient := lksdk.NewRoomServiceClient(lkInstance.URL, apiKey, apiSecret)

	_, err = roomClient.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     roomName,
		Identity: userID,
	})
	if err != nil {
		meta := map[string]string{"room": roomName, "channel_id": channelID, "error": err.Error()}
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			// Expected when participant already left LiveKit (e.g. network drop, orphan sweep after LiveKit timeout)
			log.Printf("[voice] removeParticipant: user=%s room=%s already gone (not found)", userID, roomName)
			s.logWarn(models.LogCategoryVoice, &userID, "removeParticipant: participant already left LiveKit", meta)
		} else {
			log.Printf("[voice] removeParticipant: user=%s room=%s result: %v", userID, roomName, err)
			s.logError(models.LogCategoryVoice, &userID, "removeParticipant: LiveKit API call failed", meta)
		}
		return
	}

	log.Printf("[voice] removeParticipant: successfully removed user=%s from room=%s", userID, roomName)
}

// StartAFKChecker periodically checks for inactive voice users and kicks them.
// Runs every 30 seconds — checks each user's LastActivity against the server's afk_timeout_minutes.
func (s *voiceService) StartAFKChecker() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepAFKUsers()
		}
	}()
}

// sweepAFKUsers finds and kicks users who exceeded their server's AFK timeout.
// Two-phase: identify AFK users under read lock, then kick outside lock.
func (s *voiceService) sweepAFKUsers() {
	now := time.Now()

	// Phase 1: identify potential AFK users under read lock
	type candidate struct {
		userID    string
		channelID string
		idleSince time.Time
	}
	var candidates []candidate

	s.mu.RLock()
	for userID, state := range s.states {
		// Skip users who are streaming — they're actively sharing content
		if state.IsStreaming {
			continue
		}
		candidates = append(candidates, candidate{
			userID:    userID,
			channelID: state.ChannelID,
			idleSince: state.LastActivity,
		})
	}
	s.mu.RUnlock()

	if len(candidates) == 0 {
		return
	}

	// Phase 2: check each candidate against server AFK timeout (requires DB lookups)
	// Group by channel to minimize DB queries
	channelTimeouts := make(map[string]time.Duration) // channelID -> timeout
	channelInfo := make(map[string]afkEntry)          // channelID -> server/channel names

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var toKick []afkEntry

	for _, c := range candidates {
		timeout, ok := channelTimeouts[c.channelID]
		if !ok {
			channel, err := s.channelGetter.GetByID(ctx, c.channelID)
			if err != nil {
				continue
			}
			server, err := s.afkTimeoutGetter.GetByID(ctx, channel.ServerID)
			if err != nil {
				continue
			}
			timeout = time.Duration(server.AFKTimeoutMinutes) * time.Minute
			channelTimeouts[c.channelID] = timeout
			channelInfo[c.channelID] = afkEntry{
				channelID:   c.channelID,
				channelName: channel.Name,
				serverID:    server.ID,
				serverName:  server.Name,
			}
		}

		if timeout <= 0 {
			continue
		}

		if now.Sub(c.idleSince) >= timeout {
			info := channelInfo[c.channelID]
			toKick = append(toKick, afkEntry{
				userID:      c.userID,
				channelID:   info.channelID,
				channelName: info.channelName,
				serverID:    info.serverID,
				serverName:  info.serverName,
			})
		}
	}

	// Phase 3: kick AFK users
	for _, entry := range toKick {
		log.Printf("[voice] AFK kick: user=%s channel=%s server=%s (idle too long)", entry.userID, entry.channelID, entry.serverID)

		// Notify user before disconnect
		s.hub.BroadcastToUser(entry.userID, ws.Event{
			Op: ws.OpVoiceAFKKick,
			Data: ws.VoiceAFKKickData{
				ChannelID:   entry.channelID,
				ChannelName: entry.channelName,
				ServerName:  entry.serverName,
			},
		})

		// Use the existing disconnect flow
		s.DisconnectUser(entry.userID)
	}
}
