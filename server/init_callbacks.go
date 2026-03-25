package main

import (
	"context"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// registerHubCallbacks wires Hub events to service layer logic.
// Callbacks run in separate goroutines (launched by Hub) to avoid mutex deadlock.
func registerHubCallbacks(
	hub *ws.Hub,
	userRepo repository.UserRepository,
	dmRepo repository.DMRepository,
	voiceService services.VoiceService,
	p2pCallService services.P2PCallService,
	channelRepo repository.ChannelRepository,
	serverRepo repository.ServerRepository,
) {
	// ─── Presence Callbacks ───

	hub.OnUserFirstConnect(func(userID, _ string) {
		// Read persistent pref_status from DB (not client-provided — client may differ per device).
		user, err := userRepo.GetByID(context.Background(), userID)
		if err != nil {
			log.Printf("[presence] failed to get user %s: %v", userID, err)
			return
		}

		targetStatus := user.PrefStatus
		if targetStatus == "" {
			targetStatus = models.UserStatusOnline
		}

		if targetStatus == models.UserStatusOffline {
			// Invisible — SetInvisible already called in handler.
			hub.BroadcastToAll(ws.Event{
				Op: ws.OpPresence,
				Data: ws.PresenceData{
					UserID: userID,
					Status: string(models.UserStatusOffline),
				},
			})
			log.Printf("[presence] user %s connected as invisible (pref_status=offline)", userID)
			return
		}

		if updateErr := userRepo.UpdateStatus(context.Background(), userID, targetStatus); updateErr != nil {
			log.Printf("[presence] failed to update status for user %s: %v", userID, updateErr)
		}

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(targetStatus),
			},
		})
		log.Printf("[presence] user %s connected with status %s (from pref_status)", userID, targetStatus)
	})

	hub.OnUserFullyDisconnected(func(userID, _ string) {
		if updateErr := userRepo.UpdateStatus(context.Background(), userID, models.UserStatusOffline); updateErr != nil {
			log.Printf("[presence] failed to set offline for user %s: %v", userID, updateErr)
		}

		hub.SetInvisible(userID, false)

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOffline),
			},
		})
		log.Printf("[presence] user %s disconnected (DB set to offline)", userID)

		// Voice state is NOT cleaned here — WS disconnect != voice leave.
		// LiveKit connection is separate; WS may reconnect shortly.
		// Cleaned by explicit voice_leave or orphan cleanup sweep.

		p2pCallService.HandleDisconnect(userID)
	})

	hub.OnPresenceManualUpdate(func(userID string, status string) {
		ctx := context.Background()
		st := models.UserStatus(status)

		if err := userRepo.UpdateStatus(ctx, userID, st); err != nil {
			log.Printf("[presence] failed to set %s for user %s: %v", status, userID, err)
			return
		}

		// Persist preference so it survives reconnects and cross-device sessions
		if err := userRepo.UpdatePrefStatus(ctx, userID, st); err != nil {
			log.Printf("[presence] failed to set pref_status %s for user %s: %v", status, userID, err)
		}

		hub.SetInvisible(userID, status == string(models.UserStatusOffline))

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: status,
			},
		})
		log.Printf("[presence] user %s is now %s (manual)", userID, status)
	})

	// ─── Voice Callbacks ───

	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID); err != nil {
			log.Printf("[voice] join error user=%s channel=%s: %v", userID, channelID, err)
			return
		}

		// Track last voice activity for admin panel
		if actErr := userRepo.UpdateLastVoiceActivity(context.Background(), userID); actErr != nil {
			log.Printf("[voice] failed to update user voice activity user=%s: %v", userID, actErr)
		}

		// Track server-level voice activity
		ch, chErr := channelRepo.GetByID(context.Background(), channelID)
		if chErr != nil {
			log.Printf("[voice] channel lookup for activity tracking failed channel=%s: %v", channelID, chErr)
			return
		}
		if actErr := serverRepo.UpdateLastVoiceActivity(context.Background(), ch.ServerID); actErr != nil {
			log.Printf("[voice] failed to update server voice activity server=%s: %v", ch.ServerID, actErr)
		}
	})
	hub.OnVoiceLeave(func(userID string) {
		if err := voiceService.LeaveChannel(userID); err != nil {
			log.Printf("[voice] leave error user=%s: %v", userID, err)
		}
	})
	hub.OnVoiceStateUpdate(func(userID string, isMuted, isDeafened, isStreaming *bool) {
		if err := voiceService.UpdateState(userID, isMuted, isDeafened, isStreaming); err != nil {
			log.Printf("[voice] state update error user=%s: %v", userID, err)
		}
	})
	hub.OnVoiceAdminStateUpdate(func(adminUserID, targetUserID string, isServerMuted, isServerDeafened *bool) {
		if err := voiceService.AdminUpdateState(context.Background(), adminUserID, targetUserID, isServerMuted, isServerDeafened); err != nil {
			log.Printf("[voice] admin state update error admin=%s target=%s: %v", adminUserID, targetUserID, err)
		}
	})
	hub.OnVoiceMoveUser(func(moverUserID, targetUserID, targetChannelID string) {
		if err := voiceService.MoveUser(context.Background(), moverUserID, targetUserID, targetChannelID); err != nil {
			log.Printf("[voice] move user error mover=%s target=%s channel=%s: %v", moverUserID, targetUserID, targetChannelID, err)
		}
	})
	hub.OnVoiceDisconnectUser(func(disconnecterUserID, targetUserID string) {
		if err := voiceService.AdminDisconnectUser(context.Background(), disconnecterUserID, targetUserID); err != nil {
			log.Printf("[voice] disconnect user error disconnecter=%s target=%s: %v", disconnecterUserID, targetUserID, err)
		}
	})
	hub.OnScreenShareWatch(func(viewerUserID, streamerUserID string, watching bool) {
		voiceService.WatchScreenShare(viewerUserID, streamerUserID, watching)
	})
	hub.OnVoiceActivity(func(userID string) {
		voiceService.UpdateActivity(userID)
	})

	// ─── P2P Call Callbacks ───

	hub.OnP2PCallInitiate(func(callerID string, data ws.P2PCallInitiateData) {
		callType := models.P2PCallType(data.CallType)
		if err := p2pCallService.InitiateCall(callerID, data.ReceiverID, callType); err != nil {
			log.Printf("[p2p] initiate error caller=%s receiver=%s: %v", callerID, data.ReceiverID, err)
		}
	})
	hub.OnP2PCallAccept(func(userID string, data ws.P2PCallAcceptData) {
		if err := p2pCallService.AcceptCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] accept error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallDecline(func(userID string, data ws.P2PCallDeclineData) {
		if err := p2pCallService.DeclineCall(userID, data.CallID); err != nil {
			log.Printf("[p2p] decline error user=%s call=%s: %v", userID, data.CallID, err)
		}
	})
	hub.OnP2PCallEnd(func(userID string) {
		if err := p2pCallService.EndCall(userID); err != nil {
			log.Printf("[p2p] end error user=%s: %v", userID, err)
		}
	})
	hub.OnP2PSignal(func(senderID string, data ws.P2PSignalData) {
		if err := p2pCallService.RelaySignal(senderID, data.CallID, data); err != nil {
			log.Printf("[p2p] signal relay error sender=%s call=%s: %v", senderID, data.CallID, err)
		}
	})

	// ─── Channel Typing Callback ───
	// Validates sender has ReadMessages permission, then broadcasts to server members only.

	hub.OnChannelTyping(func(senderUserID, senderUsername, channelID string) {
		ch, chErr := channelRepo.GetByID(context.Background(), channelID)
		if chErr != nil {
			return
		}

		// Verify sender is a server member by checking if client has this server
		// (serverIDs are populated from DB at WS connect and kept in sync)
		hub.BroadcastToServerExcept(ch.ServerID, senderUserID, ws.Event{
			Op: ws.OpTypingStart,
			Data: ws.TypingStartData{
				UserID:    senderUserID,
				Username:  senderUsername,
				ChannelID: channelID,
			},
		})
	})

	// ─── DM Typing Callback ───

	hub.OnDMTyping(func(senderUserID, senderUsername, dmChannelID string) {
		channel, err := dmRepo.GetChannelByID(context.Background(), dmChannelID)
		if err != nil {
			return
		}
		if channel.User1ID != senderUserID && channel.User2ID != senderUserID {
			return
		}
		otherUserID := channel.User1ID
		if otherUserID == senderUserID {
			otherUserID = channel.User2ID
		}
		hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMTypingStart,
			Data: ws.DMTypingStartData{
				UserID:      senderUserID,
				Username:    senderUsername,
				DMChannelID: dmChannelID,
			},
		})
	})
}
