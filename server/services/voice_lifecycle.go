// Package services — background voice goroutines and LiveKit cleanup.
// Orphan state sweep handles abandoned WS connections; AFK sweep kicks users
// who have been idle longer than their server's afk_timeout_minutes.
package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
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

// sfuRecheckInterval bounds how often the orphan sweep asks the SFU about one websocket-less user it
// has already confirmed present. Between asks the user is simply kept; the reconciliation sweep
// still runs on its own cadence underneath.
const sfuRecheckInterval = 60 * time.Second

// wsAbsentCeiling is the floor beneath the AFK timeout: a user with no WebSocket for this long is
// reaped even while the SFU still reports them present. Where AFK is enabled the AFK sweep fires
// first — LastActivity is refreshed only over the WebSocket (OpVoiceActivity), so a backgrounded
// client is idle by definition and goes at afk_timeout_minutes, default 60. This only decides
// anything where an admin set AFK to 0, and it is what stops a forgotten phone from holding the
// channel's timer, binding and ephemeral chat forever. Blind to audio on purpose: the SFU cannot
// tell a suspended microphone from a quiet one, and a user it drops can simply rejoin.
const wsAbsentCeiling = 2 * time.Hour

// livekitReconcileInterval / livekitAbsentGrace govern the LiveKit reconciliation
// sweep. LiveKit (the SFU actually carrying the audio) is the source of truth for
// who is really in a call. The WS-presence-based orphan sweep can't reap a session
// abandoned without an explicit leave while the user stays online elsewhere (a
// second tab/device) — that phantom keeps a channel's call timer running forever.
// The grace must comfortably exceed a normal LiveKit reconnect so a user mid-join
// or mid-reconnect (briefly absent from the SFU) is never reaped on a transient
// miss; it takes 2+ consecutive absent polls.
const (
	livekitReconcileInterval = 60 * time.Second
	livekitAbsentGrace       = 90 * time.Second
)

type orphanEntry struct {
	userID    string
	channelID string
	serverID  string
	// The instance the channel was released from when this orphan emptied it, or "" if others
	// remain. The SFU teardown has to address that exact instance.
	instanceID string
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

// sweepOrphanStates decides, every 5 seconds, whether a user whose WebSocket has been gone for
// orphanGracePeriod is still in the call — and the SFU has the deciding vote. The WebSocket dying
// is necessary to reap but never sufficient: a backgrounded iOS client loses its WebView, and with
// it the socket, while its LiveKit session keeps carrying audio (DECISIONS.md, 2026-09-07). Three
// phases, the same shape as sweepLiveKitReconciliation, because the SFU query is network I/O and
// s.mu must never be held across it:
//  1. Under Lock: track first-seen-offline per user, clear anyone back online (unchanged).
//  2. Under Lock: collect grace-expired candidates by channel. Do NOT reap yet.
//     Without the lock: ask LiveKit who is in each candidate channel.
//  3. Under Lock: a user the SFU still has is kept; a user it does not have is re-verified and
//     reaped exactly as before. A channel the SFU could not answer for is skipped whole — in doubt,
//     keep. The reconciliation sweep's own absence grace is the backstop for the ghost this leaves.
//
// Cost: steady state runs no query at all — phase 2 only fires for candidates past the grace, and
// a user the SFU confirmed is not asked about again for sfuRecheckInterval. The grace itself is
// unchanged, so the guard tests define the timing.
func (s *voiceService) sweepOrphanStates() {
	onlineIDs := s.onlineChecker.GetOnlineUserIDs()
	onlineSet := make(map[string]bool, len(onlineIDs))
	for _, id := range onlineIDs {
		onlineSet[id] = true
	}

	now := time.Now()

	// candidate is a user past the grace whose fate the SFU decides.
	type candidate struct {
		userID    string
		serverID  string
		channelID string
	}
	byChannel := make(map[string][]candidate)

	s.mu.Lock()

	// Phase 1: track newly offline users, clear returned-online users.
	for userID := range s.states {
		if onlineSet[userID] {
			delete(s.offlineSince, userID)
			delete(s.sfuPresentAt, userID)
		} else if _, tracked := s.offlineSince[userID]; !tracked {
			s.offlineSince[userID] = now
		}
	}

	// Phase 2a: collect, do not reap. The SFU has not been asked yet.
	for userID, offlineTime := range s.offlineSince {
		if now.Sub(offlineTime) < orphanGracePeriod {
			continue
		}
		state, ok := s.states[userID]
		if !ok {
			delete(s.offlineSince, userID)
			delete(s.sfuPresentAt, userID)
			continue
		}
		// Confirmed present recently — no point asking again this tick. The entry goes whenever
		// offlineSince goes, so it cannot outlive the offline episode it belongs to.
		if at, ok := s.sfuPresentAt[userID]; ok && now.Sub(at) < sfuRecheckInterval {
			continue
		}
		byChannel[state.ChannelID] = append(byChannel[state.ChannelID], candidate{
			userID: userID, serverID: state.ServerID, channelID: state.ChannelID,
		})
	}

	// Stale trackers for users who left voice explicitly during the grace.
	for userID := range s.offlineSince {
		if _, ok := s.states[userID]; !ok {
			delete(s.offlineSince, userID)
			delete(s.sfuPresentAt, userID)
		}
	}

	// Bindings whose channel has nobody in it and nobody arriving. Runs here, on every tick, rather
	// than after the reap as it used to: the reap now lives in a second lock section that ticks with
	// no candidates never reach, and a reap that empties a channel already releases its binding
	// through cleanupRoomPassphraseIfEmpty. A candidate is still in s.states at this point, so the
	// occupancy this sweep reads is unchanged by the move.
	s.sweepAbandonedBindingsLocked()

	s.mu.Unlock()

	if len(byChannel) == 0 {
		return
	}

	// Phase 2b: ask the SFU, no lock held.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var gone, present []candidate
	for channelID, cands := range byChannel {
		inRoom, err := s.listLiveKitParticipants(ctx, cands[0].serverID, channelID)
		if err != nil {
			// Unreachable is not absent. Nobody in this channel is touched this tick.
			log.Printf("[voice] orphan sweep: cannot list channel %s, keeping %d candidate(s): %v", channelID, len(cands), err)
			continue
		}
		for _, c := range cands {
			if inRoom[c.userID] {
				present = append(present, c)
			} else {
				gone = append(gone, c)
			}
		}
	}

	// The online set is sampled again: a user who reconnected while the SFU was being asked must
	// not be reaped on the strength of a snapshot taken before they came back.
	onlineNow := make(map[string]bool)
	for _, id := range s.onlineChecker.GetOnlineUserIDs() {
		onlineNow[id] = true
	}
	now = time.Now()

	var orphans []orphanEntry

	// Phase 3: act under Lock, re-verifying each candidate against the state it has now.
	s.mu.Lock()

	// ceiled marks a present user whose websocket has been gone past wsAbsentCeiling; they join the
	// reap below and the log says why, because "absent from SFU" would be false for them.
	ceiled := make(map[string]bool)
	for _, c := range present {
		state, ok := s.states[c.userID]
		if !ok || state.ChannelID != c.channelID {
			continue
		}
		if since, tracked := s.offlineSince[c.userID]; tracked && now.Sub(since) >= wsAbsentCeiling {
			ceiled[c.userID] = true
			gone = append(gone, c)
			continue
		}
		s.sfuPresentAt[c.userID] = now
		log.Printf("[voice] orphan sweep: user %s has no websocket but the SFU still has them in channel %s; keeping", c.userID, c.channelID)
	}

	for _, c := range gone {
		state, ok := s.states[c.userID]
		if !ok || state.ChannelID != c.channelID {
			continue // left or moved between phases — nothing to reap
		}
		if onlineNow[c.userID] {
			delete(s.offlineSince, c.userID)
			delete(s.sfuPresentAt, c.userID)
			continue // back before we acted; phase 1 would clear them next tick anyway
		}
		offlineTime, tracked := s.offlineSince[c.userID]
		if !tracked {
			continue
		}

		// Grace expired and the SFU agrees — confirmed abandoned session. Unchanged from here.
		channelID := state.ChannelID
		serverID := state.ServerID
		username := state.Username
		displayName := state.DisplayName
		avatarURL := s.urlSigner.SignURL(state.AvatarURL)
		delete(s.states, c.userID)
		delete(s.offlineSince, c.userID)
		delete(s.sfuPresentAt, c.userID)
		delete(s.livekitAbsentSince, c.userID)

		s.broadcastToServer(serverID, ws.Event{
			Op: ws.OpVoiceStateUpdate,
			Data: ws.VoiceStateUpdateBroadcast{
				UserID:      c.userID,
				ChannelID:   channelID,
				Username:    username,
				DisplayName: displayName,
				AvatarURL:   avatarURL,
				Action:      "leave",
			},
		})

		// Stop the channel's call timer when this reap empties it — same as
		// LeaveChannel. Without this, an abandoned session reaped here leaves the
		// timer running forever: it counts up endlessly, blocks the next join's
		// startChannelTimerLocked (no-op since it still "exists") so no fresh
		// timer_start is broadcast, and resyncs serve the stale start time.
		if s.countInChannelLocked(channelID) == 0 {
			s.stopChannelTimerLocked(channelID, serverID)
		}

		releasedInstance := s.cleanupRoomPassphraseIfEmpty(channelID)
		orphans = append(orphans, orphanEntry{userID: c.userID, channelID: channelID, serverID: serverID, instanceID: releasedInstance})
		reason := "absent from SFU"
		if ceiled[c.userID] {
			reason = "SFU still had them, no websocket past the ceiling"
		}
		log.Printf("[voice] orphan cleanup: removed user %s from channel %s (offline for %s, %s)", c.userID, channelID, now.Sub(offlineTime).Round(time.Second), reason)
		s.logWarn(models.LogCategoryVoice, &c.userID, "orphan cleanup: stale voice state removed", map[string]string{
			"channel_id":      channelID,
			"offline_seconds": fmt.Sprintf("%.0f", now.Sub(offlineTime).Seconds()),
			"reap_reason":     reason,
		})
	}

	s.mu.Unlock()

	// LiveKit cleanup outside lock (involves DB calls)
	for _, o := range orphans {
		s.removeParticipantFromLiveKit(o.serverID, o.channelID, o.userID, o.instanceID)
	}
}

// newLiveKitRoomClient builds a room-service client for a room that already exists. Shared by
// every server-side LiveKit operation (participant removal, participant listing, server-mute
// enforcement).
//
// It deliberately does NOT go through resolveRoomInstance: that one claims an instance for an
// unbound channel, and none of these callers is a join. The teardown path in particular runs
// immediately after the binding is released, so claiming there re-bound the channel it had just
// freed and then addressed the wrong machine.
//
// instanceID pins the target. Teardown callers pass the instance they just released, because after
// a release nothing else can say where the room was. "" means "wherever the channel is currently
// bound", which is right for callers acting on a channel that still has people in it.
//
// MUST NOT be called under mu.Lock (does DB lookups).
func (s *voiceService) newLiveKitRoomClient(ctx context.Context, channelID, instanceID string) (*lksdk.RoomServiceClient, error) {
	var room *roomCredentials
	var err error
	if instanceID != "" {
		room, err = s.credentialsByID(ctx, instanceID)
	} else {
		room, err = s.boundRoomInstance(ctx, channelID)
	}
	if err != nil {
		return nil, err
	}
	return lksdk.NewRoomServiceClient(room.URL, room.APIKey, room.APISecret), nil
}

// removeParticipantFromLiveKit explicitly removes a participant from the LiveKit server.
// Without this, phantom participants linger until ICE/DTLS timeout.
// Best-effort: errors are logged but not propagated.
// MUST NOT be called under mu.Lock (does DB lookups).
//
// serverID is passed by the caller (captured from the voice state) rather than resolved
// from the channel row: a channel's ServerID is immutable, so the two always match, and
// passing it keeps teardown working after the channel row is deleted (channel/server
// delete) — a channel lookup here would fail and silently skip the SFU removal.
func (s *voiceService) removeParticipantFromLiveKit(serverID, channelID, userID, instanceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	roomClient, err := s.newLiveKitRoomClient(ctx, channelID, instanceID)
	if errors.Is(err, errChannelNotBound) {
		return // no room was ever opened for this channel, so there is no participant to remove
	}
	if err != nil {
		log.Printf("[voice] removeParticipant: room client init failed for server %s: %v", serverID, err)
		s.logError(models.LogCategoryVoice, &userID, "removeParticipant: room client init failed", map[string]string{
			"server_id": serverID, "channel_id": channelID, "error": err.Error(),
		})
		return
	}

	roomName := generateRoomName(serverID, channelID)

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

// listLiveKitParticipants returns the set of base user IDs currently connected to
// the LiveKit room for (serverID, channelID). Screen-share sub-participants
// ("{userID}_ss") are normalized to their base userID so a user publishing a screen
// share still counts as present. LiveKit is the source of truth for room membership.
// MUST NOT be called under s.mu (does DB lookups + network I/O).
func (s *voiceService) listLiveKitParticipants(ctx context.Context, serverID, channelID string) (map[string]bool, error) {
	roomClient, err := s.newLiveKitRoomClient(ctx, channelID, "")
	if errors.Is(err, errChannelNotBound) {
		// No binding means no room, so nobody is in it. Say that rather than erroring: the caller
		// skips a channel it cannot query, and skipping means phantom participants are never reaped
		// and the channel timer runs forever. Before per-channel binding this path always resolved
		// and LiveKit answered for an absent room, which is the behaviour being restored here.
		// A genuinely mid-move user is covered by livekitAbsentGrace, not by pretending to see them.
		return map[string]bool{}, nil
	}
	if err != nil {
		return nil, err
	}

	roomName := generateRoomName(serverID, channelID)

	resp, err := roomClient.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: roomName})
	if err != nil {
		// Room not found = the SFU closed it because it's empty. That is a
		// CONFIRMED-empty signal (the exact phantom case), not a transient
		// failure — return an empty set so its stale states get reaped.
		if strings.Contains(err.Error(), "not_found") || strings.Contains(err.Error(), "not found") {
			return map[string]bool{}, nil
		}
		return nil, fmt.Errorf("list participants room=%s: %w", roomName, err)
	}

	present := make(map[string]bool, len(resp.Participants))
	for _, p := range resp.Participants {
		present[strings.TrimSuffix(p.Identity, "_ss")] = true
	}
	return present, nil
}

// StartLiveKitReconciliation periodically reconciles in-memory voice state against
// LiveKit room membership. Reaps phantom states (and the call timers they keep alive)
// for users no longer connected to the SFU. Read-only against LiveKit; only acts to
// remove state that LiveKit confirms is gone.
func (s *voiceService) StartLiveKitReconciliation() {
	go func() {
		ticker := time.NewTicker(livekitReconcileInterval)
		defer ticker.Stop()

		for range ticker.C {
			s.sweepLiveKitReconciliation()
		}
	}()
}

// sweepLiveKitReconciliation removes voice states whose owner is not in the LiveKit
// room, using LiveKit as the source of truth. Three phases (mirrors sweepAFKUsers):
//  1. Snapshot active channels and their users under RLock.
//  2. Query LiveKit per channel WITHOUT the lock. On error, skip that channel —
//     a transient API failure must never trigger a false reap.
//  3. Under Lock, apply a per-user grace: a user absent from LiveKit is only reaped
//     after livekitAbsentGrace, so a mid-join / mid-reconnect miss is forgiven.
//
// Reaping reuses the exact leave broadcast + timer-stop the orphan sweep already
// uses, so observable join/leave behavior is unchanged.
func (s *voiceService) sweepLiveKitReconciliation() {
	// Phase 1: snapshot active channels and their users.
	type chanInfo struct {
		serverID string
		userIDs  []string
	}
	channels := make(map[string]*chanInfo) // channelID -> info

	s.mu.RLock()
	for userID, st := range s.states {
		ci, ok := channels[st.ChannelID]
		if !ok {
			ci = &chanInfo{serverID: st.ServerID}
			channels[st.ChannelID] = ci
		}
		ci.userIDs = append(ci.userIDs, userID)
	}
	s.mu.RUnlock()

	if len(channels) == 0 {
		return
	}

	// Phase 2: query LiveKit per channel (no lock).
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type absentUser struct {
		channelID string
		serverID  string
		userID    string
	}
	var absent []absentUser
	present := make(map[string]bool) // users confirmed in LiveKit (successfully queried channels)

	for channelID, ci := range channels {
		inRoom, err := s.listLiveKitParticipants(ctx, ci.serverID, channelID)
		if err != nil {
			log.Printf("[voice] livekit reconcile: list participants failed channel=%s: %v", channelID, err)
			continue // skip channel entirely — no tracker changes on transient failure
		}
		for _, userID := range ci.userIDs {
			if inRoom[userID] {
				present[userID] = true
			} else {
				absent = append(absent, absentUser{channelID: channelID, serverID: ci.serverID, userID: userID})
			}
		}
	}

	now := time.Now()

	// Phase 3: apply grace and reap under Lock.
	s.mu.Lock()

	// Users confirmed present — clear any pending absence tracking.
	for userID := range present {
		delete(s.livekitAbsentSince, userID)
	}

	for _, a := range absent {
		state, ok := s.states[a.userID]
		if !ok || state.ChannelID != a.channelID {
			// Left or moved between phases — drop tracking, let next sweep re-evaluate.
			delete(s.livekitAbsentSince, a.userID)
			continue
		}

		first, tracked := s.livekitAbsentSince[a.userID]
		if !tracked {
			s.livekitAbsentSince[a.userID] = now
			continue
		}
		if now.Sub(first) < livekitAbsentGrace {
			continue // still within grace
		}

		// Confirmed phantom — reap. Same shape as sweepOrphanStates.
		channelID := state.ChannelID
		serverID := state.ServerID
		username := state.Username
		displayName := state.DisplayName
		avatarURL := s.urlSigner.SignURL(state.AvatarURL)
		delete(s.states, a.userID)
		delete(s.livekitAbsentSince, a.userID)
		delete(s.offlineSince, a.userID)

		s.broadcastToServer(serverID, ws.Event{
			Op: ws.OpVoiceStateUpdate,
			Data: ws.VoiceStateUpdateBroadcast{
				UserID:      a.userID,
				ChannelID:   channelID,
				Username:    username,
				DisplayName: displayName,
				AvatarURL:   avatarURL,
				Action:      "leave",
			},
		})

		if s.countInChannelLocked(channelID) == 0 {
			s.stopChannelTimerLocked(channelID, serverID)
		}
		s.cleanupRoomPassphraseIfEmpty(channelID)

		log.Printf("[voice] livekit reconcile: reaped phantom user=%s channel=%s (absent from SFU for %s)", a.userID, channelID, now.Sub(first).Round(time.Second))
		s.logWarn(models.LogCategoryVoice, &a.userID, "livekit reconcile: phantom voice state removed", map[string]string{
			"channel_id":     channelID,
			"absent_seconds": fmt.Sprintf("%.0f", now.Sub(first).Seconds()),
		})
	}

	// Drop trackers for users no longer in any voice state.
	for userID := range s.livekitAbsentSince {
		if _, ok := s.states[userID]; !ok {
			delete(s.livekitAbsentSince, userID)
		}
	}

	s.mu.Unlock()
}
