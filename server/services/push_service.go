package services

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/apns"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/pkg/push"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// PushNotifier sends mobile push notifications to a user's devices. Consumed by
// DMService and P2PCallService via SetPushNotifier.
//
// Delivery is NOT gated on WebSocket presence — a backgrounded mobile app keeps its
// socket, so "is the user connected" would suppress the push exactly when it is needed.
// It IS gated on focus: if the user has a live, focused session with the chat on screen
// (typically the desktop app), a DM push is redundant and skipped. A DND or invisible
// recipient is suppressed too (matches the in-app notification-sound contract).
//
// Calls are never suppressed. Only DMs are — a missed call cannot be caught up on later.
//
// Calls fork by token: Android FCM tokens get an FCM notification, iOS PushKit
// (apns_voip) tokens get a direct APNs VoIP push (CallKit). iOS FCM tokens are
// skipped for calls — the VoIP token is the iOS call path.
type PushNotifier interface {
	NotifyDM(recipientID, senderName, content string, encrypted bool, dmChannelID, senderID string)
	NotifyCall(receiverID, callerName string, callType models.P2PCallType, callID, callerID string)
	// NotifyDMRead retracts a conversation's delivered notifications on the user's OTHER
	// devices once they have read it somewhere. A device with a live socket does this from
	// the dm_read WS event; one that is asleep or killed only has this push.
	NotifyDMRead(userID, dmChannelID string)
	// NotifyCallCancel stops the ring on the receiver's devices once the call stops ringing —
	// cancelled, declined, timed out, or answered on one of them. A backgrounded device has no
	// live WS to deliver OpP2PCallEnd, so the push is the only way to reach it.
	//
	// excludeDeviceID is the device that ACTED (answered or declined). It must never be told to
	// stop ringing: on iOS the push would land on a live call, and ignoring it means completing
	// the PushKit handler without reporting a call to CallKit, which Apple punishes by killing
	// the app and revoking VoIP delivery. Empty means "no device to exclude".
	NotifyCallCancel(receiverID, callID, excludeDeviceID string)
}

const pushBodyMaxLen = 140

// pushUserLookup is the minimal user-read interface push needs (names + language + status).
type pushUserLookup interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

type pushService struct {
	fcm       push.Sender
	apns      apns.Sender
	tokenRepo repository.PushTokenRepository
	users     pushUserLookup
	focus     ws.FocusProvider
}

func NewPushService(fcm push.Sender, apnsSender apns.Sender, tokenRepo repository.PushTokenRepository, users pushUserLookup, focus ws.FocusProvider) PushNotifier {
	return &pushService{fcm: fcm, apns: apnsSender, tokenRepo: tokenRepo, users: users, focus: focus}
}

func (s *pushService) NotifyDM(recipientID, senderName, content string, encrypted bool, dmChannelID, senderID string) {
	if !s.fcm.Enabled() && !s.apns.Enabled() {
		return
	}
	// The user is reading this conversation right now on some device — buzzing their phone
	// about a message already on their screen is the thing this whole gate exists to stop.
	if s.focus != nil && s.focus.HasFocusedViewer(recipientID, ws.FocusViewDM, dmChannelID) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		lang, suppressed := s.recipientPush(ctx, recipientID)
		if suppressed {
			return // recipient is in DND / invisible — honor "Pause notifications"
		}

		// Fallback if the caller couldn't supply a name (message.Author not populated).
		if senderName == "" {
			if u, err := s.users.GetByID(ctx, senderID); err == nil && u != nil {
				senderName = pushDisplayName(u)
			}
		}

		loc := i18n.NewLocalizer(lang)

		// Plaintext shows content; E2EE can't be read by the server -> generic.
		body := loc.T("push.newMessage")
		if !encrypted && content != "" {
			body = truncateRunes(content, pushBodyMaxLen)
		}

		data := map[string]string{
			"type":          "dm",
			"dm_channel_id": dmChannelID,
			"sender_id":     senderID,
		}

		// Android FCM tokens get an FCM notification; iOS APNs tokens get a direct APNs
		// alert push (iOS has no FCM). VoIP tokens are for calls only, skipped here.
		if s.fcm.Enabled() {
			s.sendFCM(ctx, recipientID, push.Notification{
				Title:    senderName,
				Body:     body,
				Category: push.CategoryMessage,
				Data:     data,
				Tag:      dmNotificationTag(dmChannelID),
			})
		}
		if s.apns.Enabled() {
			s.sendAPNsAlert(ctx, recipientID, senderName, body, data)
		}
	}()
}

// dmNotificationTag names a conversation's Android notifications so native code can find
// and cancel them later. Must match the tag MqviMessagingService cancels on dm_read.
func dmNotificationTag(dmChannelID string) string {
	return "dm:" + dmChannelID
}

func (s *pushService) NotifyDMRead(userID, dmChannelID string) {
	if !s.fcm.Enabled() {
		return // Android-only: iOS cannot be relied on to retract a delivered alert
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		s.sendFCMData(ctx, userID, map[string]string{
			"type":          "dm_read",
			"dm_channel_id": dmChannelID,
		})
	}()
}

// sendAPNsAlert delivers a user-visible alert push to the recipient's iOS APNs tokens
// (messages/DMs). Prunes tokens APNs reports permanently invalid.
func (s *pushService) sendAPNsAlert(ctx context.Context, userID, title, body string, data map[string]string) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return
	}

	aps := map[string]any{
		"alert": map[string]any{"title": title, "body": body},
		"sound": "default",
	}
	payload := map[string]any{"aps": aps}
	for k, v := range data {
		payload[k] = v
	}

	var dead []string
	for _, t := range tokens {
		if t.TokenType != models.PushTokenTypeAPNs {
			continue
		}
		if err := s.apns.SendAlert(ctx, t.Token, payload); err != nil {
			if errors.Is(err, apns.ErrTokenUnregistered) {
				dead = append(dead, t.Token)
			} else {
				log.Printf("[push] apns alert to %s: %v", userID, err)
			}
		}
	}
	if len(dead) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
			log.Printf("[push] prune apns tokens: %v", delErr)
		}
	}
}

func (s *pushService) NotifyCall(receiverID, callerName string, callType models.P2PCallType, callID, callerID string) {
	if !s.fcm.Enabled() && !s.apns.Enabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		lang, suppressed := s.recipientPush(ctx, receiverID)
		if suppressed {
			return
		}

		tokens, err := s.tokenRepo.ListByUser(ctx, receiverID)
		if err != nil {
			log.Printf("[push] list tokens for %s: %v", receiverID, err)
			return
		}

		var androidFCM, voip []string
		for _, t := range tokens {
			if t.TokenType == models.PushTokenTypeAPNsVoIP {
				voip = append(voip, t.Token)
			} else if t.Platform == "android" {
				androidFCM = append(androidFCM, t.Token)
			}
			// iOS FCM tokens are skipped for calls — the VoIP token (CallKit) is the iOS path.
		}

		// Android — high-priority DATA message so the native FirebaseMessagingService
		// builds a full-screen incoming-call notification even when the app is killed.
		// The localized title/body travel in the data so the native side stays i18n-free.
		if len(androidFCM) > 0 && s.fcm.Enabled() {
			loc := i18n.NewLocalizer(lang)
			bodyKey := "push.incomingVoiceCall"
			if callType == models.P2PCallTypeVideo {
				bodyKey = "push.incomingVideoCall"
			}
			callData := map[string]string{
				"type":      "call",
				"call_id":   callID,
				"caller_id": callerID,
				"call_type": string(callType),
				"title":     callerName,
				"body":      loc.T(bodyKey),
			}
			invalid, err := s.fcm.SendData(ctx, androidFCM, callData)
			if err != nil {
				log.Printf("[push] call FCM to %s: %v", receiverID, err)
			} else if len(invalid) > 0 {
				if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
					log.Printf("[push] prune fcm tokens: %v", delErr)
				}
			}
		}

		// iOS — APNs VoIP (CallKit). caller_name carried for the native call UI.
		if len(voip) > 0 && s.apns.Enabled() {
			payload := map[string]any{
				"call_id":     callID,
				"caller_id":   callerID,
				"caller_name": callerName,
				"call_type":   string(callType),
			}
			var dead []string
			for _, vt := range voip {
				if err := s.apns.SendVoIP(ctx, vt, payload); err != nil {
					if errors.Is(err, apns.ErrTokenUnregistered) {
						dead = append(dead, vt)
					} else {
						log.Printf("[push] voip to %s: %v", receiverID, err)
					}
				}
			}
			if len(dead) > 0 {
				if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
					log.Printf("[push] prune voip tokens: %v", delErr)
				}
			}
		}
	}()
}

func (s *pushService) NotifyCallCancel(receiverID, callID, excludeDeviceID string) {
	if !s.fcm.Enabled() && !s.apns.Enabled() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		tokens, err := s.tokenRepo.ListByUser(ctx, receiverID)
		if err != nil {
			log.Printf("[push] list tokens for %s: %v", receiverID, err)
			return
		}

		var androidFCM, voip []string
		for _, t := range tokens {
			// Never tell the device that just acted to stop ringing. On iOS that push would
			// land on a live call, and the only way to ignore it is to complete the PushKit
			// handler without reporting a call to CallKit — which Apple punishes by killing
			// the app and revoking its VoIP delivery.
			if excludeDeviceID != "" && t.DeviceID != nil && *t.DeviceID == excludeDeviceID {
				continue
			}
			if t.TokenType == models.PushTokenTypeAPNsVoIP {
				voip = append(voip, t.Token)
			} else if t.Platform == "android" {
				androidFCM = append(androidFCM, t.Token)
			}
		}

		// Android — data message the native FirebaseMessagingService uses to cancel the
		// ringing incoming-call notification.
		if len(androidFCM) > 0 && s.fcm.Enabled() {
			data := map[string]string{"type": "call_cancel", "call_id": callID}
			invalid, err := s.fcm.SendData(ctx, androidFCM, data)
			if err != nil {
				log.Printf("[push] cancel FCM to %s: %v", receiverID, err)
			} else if len(invalid) > 0 {
				if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
					log.Printf("[push] prune fcm tokens: %v", delErr)
				}
			}
		}

		// iOS — a VoIP push carrying "cancel" so CallManager dismisses the CallKit call.
		if len(voip) > 0 && s.apns.Enabled() {
			payload := map[string]any{"call_id": callID, "cancel": true}
			var dead []string
			for _, vt := range voip {
				if err := s.apns.SendVoIP(ctx, vt, payload); err != nil {
					if errors.Is(err, apns.ErrTokenUnregistered) {
						dead = append(dead, vt)
					} else {
						log.Printf("[push] cancel voip to %s: %v", receiverID, err)
					}
				}
			}
			if len(dead) > 0 {
				if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
					log.Printf("[push] prune voip tokens: %v", delErr)
				}
			}
		}
	}()
}

// sendFCM delivers a notification message to the user's FCM tokens — excluding VoIP
// tokens, which are not FCM-addressable (sending them to FCM would fail and wrongly
// prune them) — pruning any FCM reports as permanently unregistered.
// sendFCMData delivers a data-only message to the user's Android devices. Data-only is
// what reaches MqviMessagingService even when the app is backgrounded or killed — a
// notification payload would be displayed by the FCM SDK instead of handed to our code.
func (s *pushService) sendFCMData(ctx context.Context, userID string, data map[string]string) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return
	}

	var androidFCM []string
	for _, t := range tokens {
		if t.TokenType == models.PushTokenTypeFCM && t.Platform == "android" {
			androidFCM = append(androidFCM, t.Token)
		}
	}
	if len(androidFCM) == 0 {
		return
	}

	invalid, err := s.fcm.SendData(ctx, androidFCM, data)
	if err != nil {
		log.Printf("[push] send data to %s: %v", userID, err)
		return
	}
	if len(invalid) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
			log.Printf("[push] prune %d invalid tokens: %v", len(invalid), delErr)
		}
	}
}

func (s *pushService) sendFCM(ctx context.Context, userID string, n push.Notification) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return
	}

	var values []string
	for _, t := range tokens {
		if t.TokenType == models.PushTokenTypeFCM {
			values = append(values, t.Token)
		}
	}
	if len(values) == 0 {
		return
	}

	invalid, err := s.fcm.Send(ctx, values, n)
	if err != nil {
		log.Printf("[push] send to %s: %v", userID, err)
		return
	}
	if len(invalid) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
			log.Printf("[push] prune %d invalid tokens: %v", len(invalid), delErr)
		}
	}
}

// recipientPush fetches the recipient once and returns their notification language
// plus whether push must be suppressed. Suppression honors the client contract
// ("DND: You will not receive notifications" / "Pause notifications"): a DND or
// invisible (manual offline) recipient gets no push, matching the in-app
// notification-sound suppression in sounds.ts.
func (s *pushService) recipientPush(ctx context.Context, userID string) (lang string, suppressed bool) {
	u, err := s.users.GetByID(ctx, userID)
	if err != nil || u == nil {
		return i18n.DefaultLanguage, false
	}
	if u.PrefStatus == models.UserStatusDND || u.PrefStatus == models.UserStatusOffline {
		return u.Language, true
	}
	return u.Language, false
}

// pushDisplayName resolves a user's notification title: display name if set,
// otherwise username. Safe on nil.
func pushDisplayName(u *models.User) string {
	if u == nil {
		return ""
	}
	if u.DisplayName != nil && *u.DisplayName != "" {
		return *u.DisplayName
	}
	return u.Username
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
