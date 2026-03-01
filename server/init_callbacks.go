// Package main — WebSocket Hub callback wire-up.
//
// registerHubCallbacks, Hub'ın presence/voice/p2p/dm callback'lerini ayarlar.
//
// Bu callback'ler neden burada (main package'da)?
// Hub ws paketinde yaşıyor, ama DB güncellemesi service/repo katmanında.
// Hub'ın service'lere bağımlı olmasını istemiyoruz (Dependency Inversion).
// main package wire-up noktasıdır — tüm katmanları birbirine bağlar.
//
// Callback'ler Hub.Run() goroutine'inden ayrı goroutine'de çalışır
// (addClient/removeClient içinde `go callback()` ile çağrılır),
// böylece Hub'ın mutex Lock'u ile BroadcastToAll'ın RLock'u çakışmaz.
package main

import (
	"context"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// registerHubCallbacks, tüm Hub callback'lerini register eder.
//
// Parametre olarak aldığı dependency'ler:
// - hub: callback'lerin bağlanacağı WebSocket Hub
// - userRepo: presence callback'lerinde DB güncelleme için
// - dmRepo: DM typing callback'inde kanal üyesi lookup için
// - voiceService: disconnect ve voice event'leri için
// - p2pCallService: P2P arama event'leri için
// - channelRepo: ses kanalı → sunucu lookup için (voice activity tracking)
// - serverRepo: sunucu last_voice_activity güncelleme için
func registerHubCallbacks(
	hub *ws.Hub,
	userRepo repository.UserRepository,
	dmRepo repository.DMRepository,
	voiceService services.VoiceService,
	p2pCallService services.P2PCallService,
	channelRepo repository.ChannelRepository,
	serverRepo repository.ServerRepository,
) {
	// ─── Presence Callback'leri ───

	hub.OnUserFirstConnect(func(userID string) {
		user, err := userRepo.GetByID(context.Background(), userID)
		if err != nil {
			log.Printf("[presence] failed to get user %s: %v", userID, err)
			return
		}

		// DND tercihi sunucu restart'larında bile korunur.
		if user.Status == models.UserStatusDND {
			hub.BroadcastToAll(ws.Event{
				Op: ws.OpPresence,
				Data: ws.PresenceData{
					UserID: userID,
					Status: string(models.UserStatusDND),
				},
			})
			log.Printf("[presence] user %s is now dnd (restored preference)", userID)
			return
		}

		if updateErr := userRepo.UpdateStatus(context.Background(), userID, models.UserStatusOnline); updateErr != nil {
			log.Printf("[presence] failed to update status for user %s: %v", userID, updateErr)
		}

		hub.BroadcastToAll(ws.Event{
			Op: ws.OpPresence,
			Data: ws.PresenceData{
				UserID: userID,
				Status: string(models.UserStatusOnline),
			},
		})
		log.Printf("[presence] user %s is now online", userID)
	})

	hub.OnUserFullyDisconnected(func(userID string) {
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

		voiceService.DisconnectUser(userID)
		p2pCallService.HandleDisconnect(userID)
	})

	hub.OnPresenceManualUpdate(func(userID string, status string) {
		if err := userRepo.UpdateStatus(context.Background(), userID, models.UserStatus(status)); err != nil {
			log.Printf("[presence] failed to set %s for user %s: %v", status, userID, err)
			return
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

	// ─── Voice Callback'leri ───

	hub.OnVoiceJoin(func(userID, username, displayName, avatarURL, channelID string) {
		if err := voiceService.JoinChannel(userID, username, displayName, avatarURL, channelID); err != nil {
			log.Printf("[voice] join error user=%s channel=%s: %v", userID, channelID, err)
			return
		}

		// Sunucunun son ses aktivitesi zamanını güncelle (admin panel last_activity için).
		// channel → server lookup yapıp servers.last_voice_activity'yi set eder.
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

	// ─── P2P Call Callback'leri ───

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
