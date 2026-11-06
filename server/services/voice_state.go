// Package services — voice channel join/leave/update and state queries.
// Owns the central `states` map lifecycle; all mutations happen here or in
// voice_admin.go. Lock discipline: every state mutation is bracketed by s.mu.
package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

// emitChannelLocked queues a voice event about channelID. Its participants are read now, under
// s.mu, so the event reaches exactly who was in the channel when it happened, whether or not they
// can see it; also adds users told regardless — the subject of a leave is no longer a participant.
// Members who can see the channel are resolved by the egress worker. No-op on an empty serverID so
// malformed state cannot reach the wrong audience.
func (s *voiceService) emitChannelLocked(serverID, channelID string, event ws.Event, also ...string) {
	if serverID == "" {
		return
	}
	s.egress.channelEvent(serverID, channelID, append(s.participantsLocked(channelID), also...), event)
}

// emitToUserLocked queues a signal for one user in order with the server's voice events.
func (s *voiceService) emitToUserLocked(serverID, userID string, event ws.Event) {
	if serverID == "" {
		return
	}
	s.egress.toUser(serverID, userID, event)
}

// replaceIfHiddenLocked resyncs userID's view of serverID when they joined or left one of
// channelIDs without being able to see it. Caller holds s.mu (read or write).
func (s *voiceService) replaceIfHiddenLocked(serverID, userID string, channelIDs ...string) {
	if serverID == "" {
		return
	}
	s.egress.replaceIfHidden(serverID, userID, channelIDs, s.serverSnapshotLocked(serverID))
}

func (s *voiceService) participantsLocked(channelID string) []string {
	var ids []string
	for uid, st := range s.states {
		if st.ChannelID == channelID {
			ids = append(ids, uid)
		}
	}
	return ids
}

// serverSnapshotLocked copies serverID's voice states and the timers of their channels.
func (s *voiceService) serverSnapshotLocked(serverID string) voiceSnapshot {
	snap := voiceSnapshot{timers: make(map[string]int64)}
	for _, st := range s.states {
		if st.ServerID != serverID {
			continue
		}
		snap.states = append(snap.states, *st)
		if t, ok := s.channelStartedAt[st.ChannelID]; ok {
			snap.timers[st.ChannelID] = t.UnixMilli()
		}
	}
	return snap
}

func (s *voiceService) JoinChannel(userID, username, displayName, avatarURL, channelID string, isMuted, isDeafened bool) error {
	// The websocket's own join replaces any background try still waiting.
	s.mu.Lock()
	s.cancelDeferredJoinLocked(userID)
	s.mu.Unlock()
	_, err := s.join(voiceJoinRequest{
		userID: userID, username: username, displayName: displayName, avatarURL: avatarURL,
		channelID: channelID, isMuted: isMuted, isDeafened: isDeafened,
	}, 0)
	return err
}

// join decides and applies a voice join. attempt counts the background tries of a deferred join, 0
// for the websocket's own. Returns the channel's server once the channel could be read.
func (s *voiceService) join(req voiceJoinRequest, attempt int) (string, error) {
	userID, username, displayName, avatarURL := req.userID, req.username, req.displayName, req.avatarURL
	channelID, isMuted, isDeafened := req.channelID, req.isMuted, req.isDeafened

	// avatarURL is the raw, unsigned URL from the DB. We store it unsigned in
	// VoiceState (which lives as long as the user is in voice — could be hours)
	// and re-sign at every broadcast egress. Storing an already-signed URL would
	// expire mid-session and serve 401s to anyone who joined later via voice_states_sync.
	signedAvatar := s.urlSigner.SignURL(avatarURL)

	// Already in this channel: the websocket re-asserting it after a reconnect, which needs no
	// authorization, so none is read. Checked again under the lock below.
	reassert := s.isInChannel(userID, channelID)

	// Resolve channel's parent server before locking — all voice broadcasts are server-scoped. A
	// read that fails is not a missing channel: the join is tried again (deferJoin).
	channel, err := s.channelGetter.GetByID(context.Background(), channelID)
	if errors.Is(err, pkg.ErrNotFound) {
		return "", fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	if err != nil {
		return "", s.deferJoin(req, attempt, fmt.Errorf("read channel: %w", err))
	}
	serverID := channel.ServerID

	// Resolved before the lock: the permission lookup may hit the database.
	decision, authErr := joinAllowed, error(nil)
	if !reassert {
		decision, authErr = s.joinAuthorized(userID, channel)
	}

	var oldChannelID string
	var oldServerID string
	// The instance the old channel was released from, needed by the phantom teardown below.
	var releasedInstance string

	s.mu.Lock()

	// Decided on the state as it is now, under the lock. Being in this channel already is the WS
	// reconnect re-assert and passes; anything else is a new join and needs authorization.
	existing, inVoice := s.states[userID]
	sameChannel := inVoice && existing.ChannelID == channelID
	if reassert && !sameChannel {
		// Left, moved or removed since the check above: a new join after all, so it is authorized
		// now, and decided on the state as it is then.
		s.mu.Unlock()
		decision, authErr = s.joinAuthorized(userID, channel)
		s.mu.Lock()
		existing, inVoice = s.states[userID]
		sameChannel = inVoice && existing.ChannelID == channelID
	}
	if !sameChannel {
		switch decision {
		case joinRefused:
			s.mu.Unlock()
			log.Printf("[voice] join refused user=%s channel=%s (no token issued, no connect permission)", userID, channelID)
			return serverID, ErrVoiceJoinRefused
		case joinUnknown:
			s.mu.Unlock()
			return serverID, s.deferJoin(req, attempt, authErr)
		}
	}

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
			// Rejoin is a sign of life (F5 / WS reconnect re-assert) — reset the
			// LiveKit absence grace so a stale timestamp can't cause a short-grace
			// reap before the client re-establishes its SFU connection.
			delete(s.livekitAbsentSince, userID)
			s.mu.Unlock()
			log.Printf("[voice] same-channel rejoin user=%s channel=%s (no broadcast)", userID, channelID)
			s.joined(userID, serverID)
			return serverID, nil
		}

		releasedInstance = s.removeVoiceStateLocked(existing)
	}

	// The websocket join landed, so the token-time marker (or a deferred join's) has done its job.
	s.clearPendingJoinLocked(channelID, userID)

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
	delete(s.livekitAbsentSince, userID) // fresh session — reset LiveKit absence grace

	s.emitChannelLocked(serverID, channelID, ws.Event{
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

	// A force-moved user may be in a channel they cannot see: they hold none of its participants.
	s.replaceIfHiddenLocked(serverID, userID, channelID)

	s.mu.Unlock()

	// Remove phantom participant from old LiveKit room (best-effort, outside lock).
	// Use oldServerID — the phantom is in the OLD channel's room, which may be on a
	// different server than the one just joined.
	if oldChannelID != "" && oldChannelID != channelID {
		go s.removeParticipantFromLiveKit(oldServerID, oldChannelID, userID, releasedInstance)
	}

	log.Printf("[voice] user %s joined channel %s", userID, channelID)
	s.joined(userID, serverID)
	return serverID, nil
}

// joined runs the join callback, outside s.mu.
func (s *voiceService) joined(userID, serverID string) {
	if s.onJoined != nil {
		s.onJoined(userID, serverID)
	}
}

func (s *voiceService) LeaveChannel(userID string) error {
	// A join still waiting to be decided is left too.
	s.mu.Lock()
	s.cancelDeferredJoinLocked(userID)
	s.mu.Unlock()
	s.leaveWhere(userID, nil, nil, nil)
	return nil
}

// isInChannel reports whether userID is in voice in channelID right now.
func (s *voiceService) isInChannel(userID, channelID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st, ok := s.states[userID]
	return ok && st.ChannelID == channelID
}

func (s *voiceService) DisconnectUserFromServer(userID, serverID string) bool {
	return s.leaveWhere(userID, func(st *models.VoiceState) bool { return st.ServerID == serverID }, nil, nil)
}

func (s *voiceService) DisconnectUserFromChannel(userID, channelID string) bool {
	return s.leaveWhere(userID, inVoiceChannel(channelID), nil, nil)
}

func inVoiceChannel(channelID string) func(*models.VoiceState) bool {
	return func(st *models.VoiceState) bool { return st.ChannelID == channelID }
}

// leaveWhere takes userID out of voice if match accepts their current state (nil matches any).
// Deciding and removing under one lock is what lets a caller act on an earlier snapshot: a user who
// moved since is left alone. before/after are queued for the user around the leave.
func (s *voiceService) leaveWhere(userID string, match func(*models.VoiceState) bool, before, after *ws.Event) bool {
	s.mu.Lock()
	state, ok := s.states[userID]
	if !ok || (match != nil && !match(state)) {
		s.mu.Unlock()
		return false
	}
	channelID := state.ChannelID
	serverID := state.ServerID
	if before != nil {
		s.emitToUserLocked(serverID, userID, *before)
	}
	releasedInstance := s.removeVoiceStateLocked(state)
	if after != nil {
		s.emitToUserLocked(serverID, userID, *after)
	}
	s.mu.Unlock()

	// Remove from LiveKit (best-effort, outside lock — involves DB calls). The instance is what the
	// teardown must talk to: after the release nothing else can say where the room was.
	go s.removeParticipantFromLiveKit(serverID, channelID, userID, releasedInstance)

	log.Printf("[voice] user %s left channel %s", userID, channelID)
	return true
}

// removeVoiceStateLocked is the one way a user leaves voice: the state and its trackers go, and the
// leave, the screen-share viewer bookkeeping, the timer stop and a hidden-channel resync are queued.
// Returns the instance the channel was released from, for the SFU teardown. Caller holds s.mu.
func (s *voiceService) removeVoiceStateLocked(state *models.VoiceState) string {
	userID := state.UserID
	channelID := state.ChannelID
	serverID := state.ServerID

	delete(s.states, userID)
	delete(s.livekitAbsentSince, userID)
	delete(s.offlineSince, userID)
	delete(s.sfuPresentAt, userID)

	s.emitChannelLocked(serverID, channelID, ws.Event{
		Op: ws.OpVoiceStateUpdate,
		Data: ws.VoiceStateUpdateBroadcast{
			UserID:           userID,
			ChannelID:        channelID,
			Username:         state.Username,
			DisplayName:      state.DisplayName,
			AvatarURL:        s.urlSigner.SignURL(state.AvatarURL),
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "leave",
		},
	}, userID)

	// A streamer leaving ends the share: clear its viewer set and tell the channel.
	if state.IsStreaming {
		delete(s.screenShareViewers, userID)
		s.emitChannelLocked(serverID, channelID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      channelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		}, userID)
	}
	// A viewer leaving drops out of every share they were watching.
	for streamerID, viewers := range s.screenShareViewers {
		if !viewers[userID] {
			continue
		}
		delete(viewers, userID)
		viewerCount := len(viewers)
		if viewerCount == 0 {
			delete(s.screenShareViewers, streamerID)
		}
		if streamerState, ok := s.states[streamerID]; ok {
			s.emitChannelLocked(streamerState.ServerID, streamerState.ChannelID, ws.Event{
				Op: ws.OpScreenShareViewerUpdate,
				Data: ws.ScreenShareViewerUpdateData{
					StreamerUserID: streamerID,
					ChannelID:      streamerState.ChannelID,
					ViewerCount:    viewerCount,
					ViewerUserID:   userID,
					Action:         "leave",
				},
			}, userID)
		}
	}

	if s.countInChannelLocked(channelID) == 0 {
		s.stopChannelTimerLocked(channelID, serverID, userID)
	}

	// Clean up E2EE passphrase if room is empty (forward secrecy).
	releasedInstance := s.cleanupRoomPassphraseIfEmpty(channelID)

	// A participant who could not see the channel keeps its participants until told otherwise.
	s.replaceIfHiddenLocked(serverID, userID, channelID)
	return releasedInstance
}

func (s *voiceService) UpdateState(userID string, isMuted, isDeafened, isStreaming *bool, shareQuality *string) error {
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
		// Nothing is being shared, so nothing has a ceiling — leaving the old one would have the
		// next viewer reading a quality for a share that ended.
		if !*isStreaming {
			state.ShareQuality = ""
		}
	}
	if shareQuality != nil {
		state.ShareQuality = *shareQuality
	}

	s.emitChannelLocked(state.ServerID, state.ChannelID, ws.Event{
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
			ShareQuality:     state.ShareQuality,
			IsServerMuted:    state.IsServerMuted,
			IsServerDeafened: state.IsServerDeafened,
			Action:           "update",
		},
	})

	// Streamer stopped streaming — clean up viewer tracking and broadcast final update
	if wasStreaming && !state.IsStreaming {
		delete(s.screenShareViewers, userID)
		s.emitChannelLocked(state.ServerID, state.ChannelID, ws.Event{
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
	s.emitChannelLocked(serverID, channelID, ws.Event{
		Op: ws.OpVoiceChannelTimerStart,
		Data: ws.VoiceChannelTimerStartData{
			ChannelID: channelID,
			StartedAt: now.UnixMilli(),
		},
	})
}

// stopChannelTimerLocked clears an active timer and broadcasts the stop event — to the channel's
// audience and to leaver, the user whose departure emptied it. No-op if no timer was running. Also
// fires the channel-empty callback (async) so dependent state — e.g. ephemeral voice chat — can be
// cleaned up.
func (s *voiceService) stopChannelTimerLocked(channelID, serverID, leaver string) {
	if _, exists := s.channelStartedAt[channelID]; !exists {
		return
	}
	delete(s.channelStartedAt, channelID)
	s.emitChannelLocked(serverID, channelID, ws.Event{
		Op:   ws.OpVoiceChannelTimerStop,
		Data: ws.VoiceChannelTimerStopData{ChannelID: channelID},
	}, leaver)
	if s.onChannelEmpty != nil {
		go s.onChannelEmpty(channelID)
	}
}

// SyncServerStatesToUser tells a new member of serverID about the calls already running there that
// they may see, so they do not wait for a reconnect's bulk sync.
//
// Incremental join + timer-start events (additive on the client) rather than a full
// voice_states_sync, which REPLACES the client's whole voiceStates map and would wipe the user's
// other servers' voice state. Queued under the lock so it lands in order with the server's events.
func (s *voiceService) SyncServerStatesToUser(userID, serverID string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap := s.serverSnapshotLocked(serverID)
	if len(snap.states) == 0 {
		return
	}
	s.egress.joinSync(serverID, userID, snap)
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

func (s *voiceService) GetServerParticipants(serverID string) []models.VoiceState {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var participants []models.VoiceState
	for _, state := range s.states {
		if state.ServerID == serverID {
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
	s.leaveWhere(userID, nil, nil, nil)
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

// voiceAccessPerms is what entering a voice channel takes: seeing it and connecting to it. A channel
// a member cannot see is hidden from them, and learning its id must not let them in.
const voiceAccessPerms = models.PermViewChannel | models.PermConnectVoice

func mayEnterVoice(perms models.Permission) bool { return hasAllPermissions(perms, voiceAccessPerms) }

// ErrVoiceJoinRefused is a websocket join that no token was issued for and that the user's
// permissions do not allow.
var ErrVoiceJoinRefused = fmt.Errorf("%w: not allowed to join this voice channel", pkg.ErrForbidden)

// joinAuthorized: the voice state is the credential for voice chat and the screen-share token, so a
// join that creates it is held to the token rule as it stands now — ConnectVoice, read fresh. A token
// alone proves nothing: it outlives a kick, a ban and a lost permission, and anyone can keep one fresh.
// The one exception is a token minted on a force-move grant, which stands in for ConnectVoice and so
// needs only the membership the move was made under.
//
// A read that fails decides nothing: joinUnknown with the error, never a refusal (see deferJoin).
func (s *voiceService) joinAuthorized(userID string, channel *models.Channel) (joinDecision, error) {
	if channel.Type != models.ChannelTypeVoice {
		return joinRefused, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), voiceJoinAuthTimeout)
	defer cancel()

	s.mu.RLock()
	moved := s.movedJoinPendingLocked(channel.ID, userID)
	s.mu.RUnlock()
	if moved {
		member, err := s.isServerMember(ctx, channel.ServerID, userID)
		if err != nil {
			return joinUnknown, fmt.Errorf("membership user=%s server=%s: %w", userID, channel.ServerID, err)
		}
		return decide(member), nil
	}

	perms, err := s.permResolver.ResolveChannelPermissionsFresh(ctx, userID, channel.ID)
	if err != nil {
		return joinUnknown, fmt.Errorf("permissions user=%s channel=%s: %w", userID, channel.ID, err)
	}
	return decide(mayEnterVoice(perms)), nil
}

func decide(allowed bool) joinDecision {
	if allowed {
		return joinAllowed
	}
	return joinRefused
}

const voiceJoinAuthTimeout = 5 * time.Second

// isServerMember fails without a membership source rather than guessing.
func (s *voiceService) isServerMember(ctx context.Context, serverID, userID string) (bool, error) {
	if s.membership == nil {
		return false, errors.New("no membership source")
	}
	member, err := s.membership.IsMember(ctx, serverID, userID)
	if err != nil {
		return false, fmt.Errorf("is member: %w", err)
	}
	return member, nil
}
