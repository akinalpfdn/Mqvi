package services

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/ws"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// ─── ISP Interfaces ───

// ChannelGetter retrieves channel info. Satisfied by repository.ChannelRepository.
type ChannelGetter interface {
	GetByID(ctx context.Context, id string) (*models.Channel, error)
}

// LiveKitInstanceGetter retrieves the LiveKit instance for a server.
type LiveKitInstanceGetter interface {
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
}

// OnlineUserChecker checks connected users. Used by orphan state cleanup.
type OnlineUserChecker interface {
	GetOnlineUserIDs() []string
}

// ─── VoiceService Interface ───

type VoiceService interface {
	GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error)
	JoinChannel(userID, username, displayName, avatarURL, channelID string) error
	LeaveChannel(userID string) error
	UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error
	GetChannelParticipants(channelID string) []models.VoiceState
	GetUserVoiceState(userID string) *models.VoiceState
	GetAllVoiceStates() []models.VoiceState
	DisconnectUser(userID string)
	GetStreamCount(channelID string) int
	AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error
	MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error
	AdminDisconnectUser(ctx context.Context, disconnecterUserID, targetUserID string) error
	// GetUserVoiceChannelID returns the user's active voice channel ID (empty if not in voice).
	// Satisfies UserVoiceChannelProvider for ChannelService sidebar visibility.
	GetUserVoiceChannelID(userID string) string
	StartOrphanCleanup()
}

type voiceService struct {
	states          map[string]*models.VoiceState // userID -> VoiceState
	roomPassphrases map[string]string             // roomName -> E2EE SFrame passphrase
	mu              sync.RWMutex

	channelGetter ChannelGetter
	livekitGetter LiveKitInstanceGetter
	permResolver  ChannelPermResolver
	hub           ws.Broadcaster
	onlineChecker OnlineUserChecker
	encryptionKey []byte // AES-256-GCM for LiveKit credential decryption
}

const maxScreenShares = 0 // 0 = unlimited

func NewVoiceService(
	channelGetter ChannelGetter,
	livekitGetter LiveKitInstanceGetter,
	permResolver ChannelPermResolver,
	hub ws.Broadcaster,
	onlineChecker OnlineUserChecker,
	encryptionKey []byte,
) VoiceService {
	return &voiceService{
		states:          make(map[string]*models.VoiceState),
		roomPassphrases: make(map[string]string),
		channelGetter:   channelGetter,
		livekitGetter:   livekitGetter,
		permResolver:    permResolver,
		hub:             hub,
		onlineChecker:   onlineChecker,
		encryptionKey:   encryptionKey,
	}
}

// ─── Token Generation ───

func (s *voiceService) GenerateToken(ctx context.Context, userID, username, displayName, channelID string) (*models.VoiceTokenResponse, error) {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return nil, fmt.Errorf("%w: not a voice channel", pkg.ErrBadRequest)
	}

	// channel -> server -> livekit_instance lookup
	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance for server %s: %w", channel.ServerID, err)
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api key: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt livekit api secret: %w", err)
	}

	// Resolve effective permissions (role base + channel overrides)
	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}

	if !effectivePerms.Has(models.PermConnectVoice) {
		return nil, fmt.Errorf("%w: missing voice connect permission", pkg.ErrForbidden)
	}

	// User limit check (0 = unlimited)
	if channel.UserLimit > 0 {
		participants := s.GetChannelParticipants(channelID)
		alreadyIn := false
		for _, p := range participants {
			if p.UserID == userID {
				alreadyIn = true
				break
			}
		}
		if !alreadyIn && len(participants) >= channel.UserLimit {
			return nil, fmt.Errorf("%w: voice channel is full", pkg.ErrBadRequest)
		}
	}

	canPublish := effectivePerms.Has(models.PermSpeak)
	canSubscribe := true
	canPublishData := true

	at := auth.NewAccessToken(apiKey, apiSecret)

	// Room name = "{serverID}:{channelID}" to avoid collisions across servers
	roomName := channel.ServerID + ":" + channelID

	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}

	participantName := username
	if displayName != "" {
		participantName = displayName
	}

	at.AddGrant(grant).
		SetIdentity(userID).
		SetName(participantName).
		SetValidFor(24 * time.Hour)

	token, err := at.ToJWT()
	if err != nil {
		return nil, fmt.Errorf("failed to generate livekit token: %w", err)
	}

	// E2EE: per-room SFrame passphrase (created on first join, reused for session)
	passphrase, err := s.getOrCreateRoomPassphrase(roomName)
	if err != nil {
		return nil, fmt.Errorf("failed to create E2EE passphrase: %w", err)
	}

	return &models.VoiceTokenResponse{
		Token:          token,
		URL:            lkInstance.URL,
		ChannelID:      channelID,
		E2EEPassphrase: passphrase,
	}, nil
}

// ─── Channel Join/Leave ───

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string) error {
	var oldChannelID string

	s.mu.Lock()

	// Leave current channel if in one
	if existing, ok := s.states[userID]; ok {
		oldChannelID = existing.ChannelID
		delete(s.states, userID)

		s.hub.BroadcastToAll(ws.Event{
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
		UserID:      userID,
		ChannelID:   channelID,
		Username:    username,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:      userID,
			ChannelID:   channelID,
			Username:    username,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
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
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	delete(s.states, userID)

	s.hub.BroadcastToAll(ws.Event{
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

	// Clean up E2EE passphrase if room is empty (forward secrecy)
	s.cleanupRoomPassphraseIfEmpty(channelID)

	s.mu.Unlock()

	// Remove from LiveKit (best-effort, outside lock — involves DB calls)
	go s.removeParticipantFromLiveKit(channelID, userID)

	log.Printf("[voice] user %s left channel %s", userID, channelID)
	return nil
}

// ─── State Update ───

func (s *voiceService) UpdateState(userID string, isMuted, isDeafened, isStreaming *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[userID]
	if !ok {
		return nil
	}

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

	s.hub.BroadcastToAll(ws.Event{
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

// ─── Admin State Update ───

// AdminUpdateState applies server-level mute/deafen to a user.
// Requires PermMuteMembers / PermDeafenMembers on the target's channel.
func (s *voiceService) AdminUpdateState(ctx context.Context, adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.states[targetUserID]
	if !ok {
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	effectivePerms, err := s.permResolver.ResolveChannelPermissions(ctx, adminUserID, state.ChannelID)
	if err != nil {
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}

	if isServerMuted != nil && !effectivePerms.Has(models.PermMuteMembers) {
		return fmt.Errorf("%w: mute members permission required", pkg.ErrForbidden)
	}
	if isServerDeafened != nil && !effectivePerms.Has(models.PermDeafenMembers) {
		return fmt.Errorf("%w: deafen members permission required", pkg.ErrForbidden)
	}

	if isServerMuted != nil {
		state.IsServerMuted = *isServerMuted
	}
	if isServerDeafened != nil {
		state.IsServerDeafened = *isServerDeafened
	}

	s.hub.BroadcastToAll(ws.Event{
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

	log.Printf("[voice] admin %s updated server state for user %s (muted=%v, deafened=%v)",
		adminUserID, targetUserID, state.IsServerMuted, state.IsServerDeafened)
	return nil
}

// ─── Move & Disconnect ───

// MoveUser moves a user between voice channels.
// Requires PermMoveMembers in both source and target channels.
func (s *voiceService) MoveUser(ctx context.Context, moverUserID, targetUserID, targetChannelID string) error {
	channel, err := s.channelGetter.GetByID(ctx, targetChannelID)
	if err != nil {
		return fmt.Errorf("%w: target channel not found", pkg.ErrNotFound)
	}
	if channel.Type != models.ChannelTypeVoice {
		return fmt.Errorf("%w: target is not a voice channel", pkg.ErrBadRequest)
	}

	s.mu.Lock()

	state, ok := s.states[targetUserID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("%w: target user is not in a voice channel", pkg.ErrBadRequest)
	}

	sourceChannelID := state.ChannelID

	if sourceChannelID == targetChannelID {
		s.mu.Unlock()
		return fmt.Errorf("%w: user is already in that channel", pkg.ErrBadRequest)
	}

	// Check PermMoveMembers in source channel
	sourcePerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, sourceChannelID)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("failed to resolve source channel permissions: %w", err)
	}
	if !sourcePerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required in source channel", pkg.ErrForbidden)
	}

	// Check PermMoveMembers in target channel
	targetPerms, err := s.permResolver.ResolveChannelPermissions(ctx, moverUserID, targetChannelID)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("failed to resolve target channel permissions: %w", err)
	}
	if !targetPerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required in target channel", pkg.ErrForbidden)
	}
	// Mover must also have ConnectVoice in target channel
	if !targetPerms.Has(models.PermConnectVoice) {
		s.mu.Unlock()
		return fmt.Errorf("%w: connect voice permission required in target channel", pkg.ErrForbidden)
	}

	state.ChannelID = targetChannelID

	s.cleanupRoomPassphraseIfEmpty(sourceChannelID)

	// Broadcast leave(source) + join(target)
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        sourceChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "leave",
		},
	})
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           state.UserID,
			ChannelID:        targetChannelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        state.AvatarURL,
			IsMuted:          state.IsMuted,
			IsDeafened:       state.IsDeafened,
			IsStreaming:      state.IsStreaming,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "join",
		},
	})

	s.mu.Unlock()

	// Tell client to switch LiveKit rooms
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op:   ws.OpVoiceForceMove,
		Data: ws.VoiceForceMoveData{ChannelID: targetChannelID},
	})

	// Remove phantom from old LiveKit room (best-effort)
	go s.removeParticipantFromLiveKit(sourceChannelID, targetUserID)

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
		return fmt.Errorf("failed to resolve permissions: %w", err)
	}
	if !effectivePerms.Has(models.PermMoveMembers) {
		s.mu.Unlock()
		return fmt.Errorf("%w: move members permission required", pkg.ErrForbidden)
	}

	channelID := state.ChannelID
	username := state.Username
	displayName := state.DisplayName
	avatarURL := state.AvatarURL
	delete(s.states, targetUserID)

	s.hub.BroadcastToAll(ws.Event{
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

	s.cleanupRoomPassphraseIfEmpty(channelID)

	s.mu.Unlock()

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpVoiceForceDisconnect,
	})

	go s.removeParticipantFromLiveKit(channelID, targetUserID)

	log.Printf("[voice] admin %s disconnected user %s from channel %s",
		disconnecterUserID, targetUserID, channelID)
	return nil
}

// ─── E2EE Passphrase Helpers ───

// getOrCreateRoomPassphrase returns or creates a per-room E2EE passphrase.
// 32 bytes crypto/rand -> base64. All participants in the room share the same passphrase.
func (s *voiceService) getOrCreateRoomPassphrase(roomName string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if passphrase, ok := s.roomPassphrases[roomName]; ok {
		return passphrase, nil
	}

	raw := make([]byte, 32)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", fmt.Errorf("crypto/rand failed: %w", err)
	}
	passphrase := base64.RawURLEncoding.EncodeToString(raw)

	s.roomPassphrases[roomName] = passphrase
	log.Printf("[voice] created E2EE passphrase for room %s", roomName)
	return passphrase, nil
}

// cleanupRoomPassphraseIfEmpty deletes the passphrase when a room becomes empty (forward secrecy).
// MUST be called under mu.Lock (caller holds lock).
func (s *voiceService) cleanupRoomPassphraseIfEmpty(channelID string) {
	for _, state := range s.states {
		if state.ChannelID == channelID {
			return
		}
	}

	// Room empty — clean up all matching room names (format: "{serverID}:{channelID}")
	suffix := ":" + channelID
	for roomName := range s.roomPassphrases {
		if strings.HasSuffix(roomName, suffix) {
			delete(s.roomPassphrases, roomName)
			log.Printf("[voice] cleaned up E2EE passphrase for room %s", roomName)
		}
	}
}

// StartOrphanCleanup periodically removes voice states for disconnected users.
// Runs every 30s — enough time for WS reconnects during brief disconnections.
func (s *voiceService) StartOrphanCleanup() {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepOrphanStates()
		}
	}()
}

type orphanEntry struct {
	userID    string
	channelID string
}

// sweepOrphanStates removes voice states for users no longer connected to the Hub.
// Two-phase: delete+broadcast under lock, then LiveKit cleanup outside lock.
func (s *voiceService) sweepOrphanStates() {
	onlineIDs := s.onlineChecker.GetOnlineUserIDs()
	onlineSet := make(map[string]bool, len(onlineIDs))
	for _, id := range onlineIDs {
		onlineSet[id] = true
	}

	var orphans []orphanEntry

	s.mu.Lock()
	for userID, state := range s.states {
		if !onlineSet[userID] {
			channelID := state.ChannelID
			username := state.Username
			displayName := state.DisplayName
			avatarURL := state.AvatarURL
			delete(s.states, userID)

			s.hub.BroadcastToAll(ws.Event{
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
			log.Printf("[voice] orphan cleanup: removed user %s from channel %s", userID, channelID)
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
		return
	}

	lkInstance, err := s.livekitGetter.GetByServerID(ctx, channel.ServerID)
	if err != nil {
		log.Printf("[voice] removeParticipant: livekit instance lookup failed for server %s: %v", channel.ServerID, err)
		return
	}

	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		log.Printf("[voice] removeParticipant: api key decrypt failed: %v", err)
		return
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		log.Printf("[voice] removeParticipant: api secret decrypt failed: %v", err)
		return
	}

	roomName := channel.ServerID + ":" + channelID
	roomClient := lksdk.NewRoomServiceClient(lkInstance.URL, apiKey, apiSecret)

	_, err = roomClient.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room:     roomName,
		Identity: userID,
	})
	if err != nil {
		log.Printf("[voice] removeParticipant: user=%s room=%s result: %v", userID, roomName, err)
		return
	}

	log.Printf("[voice] removeParticipant: successfully removed user=%s from room=%s", userID, roomName)
}
