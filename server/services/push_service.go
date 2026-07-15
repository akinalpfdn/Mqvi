package services

import (
	"context"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/apns"
	"github.com/akinalp/mqvi/pkg/breaker"
	"github.com/akinalp/mqvi/pkg/i18n"
	"github.com/akinalp/mqvi/pkg/push"
	"github.com/akinalp/mqvi/repository"
)

// PushNotifier sends mobile push notifications. A DM push is suppressed only when the read
// watermark PROVES the user read it — never on a client's word. iOS calls go over APNs VoIP
// (CallKit), Android over FCM.
type PushNotifier interface {
	NotifyDM(recipientID, senderName, content string, encrypted bool, dmChannelID, senderID, messageID string)
	NotifyCall(receiverID, callerName string, callType models.P2PCallType, callID, callerID string)
	NotifyDMRead(userID, dmChannelID string)
	// excludeDeviceID is the device that answered or declined. It must NEVER be told to stop
	// ringing: on iOS that push lands on a live call, and ignoring it means completing the PushKit
	// handler without reporting a call to CallKit — which Apple punishes by revoking VoIP delivery.
	NotifyCallCancel(receiverID, callID, excludeDeviceID string)
}

const pushBodyMaxLen = 140

// pushUserLookup is the minimal user-read interface push needs (names + language + status).
type pushUserLookup interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// pushPresence answers whether the user has ANY live connection. Satisfied by ws.Hub.
type pushPresence interface {
	IsOnline(userID string) bool
}

// pushReadState proves whether the user has read a message. Satisfied by the DM repository.
type pushReadState interface {
	HasRead(ctx context.Context, userID, channelID, messageID string) (bool, error)
}

const (
	// Past the bound, deliver at once rather than queue: fail toward a delivered notification.
	maxPendingDMPushes = 10_000
	// Each queued push wants a database connection and the pool has four. Calls are exempt.
	maxQueuedDMPushes = 1024
	// Past the cap, records are dropped and retraction becomes unconditional. See saturated.
	maxTrackedNotifications = 100_000

	pushTimeout = 15 * time.Second
)

// Why a notification was NOT sent. Grep reason= to answer "why did this user get nothing?".
const (
	reasonDisabled    = "push_disabled"
	reasonProviderRow = "provider_down"
	reasonDND         = "dnd_or_invisible"
	reasonNoTokens    = "no_tokens"
	reasonAlreadyRead = "already_read"
	reasonShed        = "backlog_full"
)

// PushStats is a snapshot of what push has been doing. Read by /api/health/ready.
type PushStats struct {
	Sent       int64 `json:"sent"`
	Suppressed int64 `json:"suppressed"`
	Failed     int64 `json:"failed"`
	Shed       int64 `json:"shed"`
	Deferred   int64 `json:"deferred"`
	InFlight   int64 `json:"in_flight"`
	FCMUp      bool  `json:"fcm_up"`
	APNsUp     bool  `json:"apns_up"`
}

// PushStatsProvider is the health endpoint's view of the push service.
type PushStatsProvider interface {
	Stats() PushStats
}

type pushService struct {
	fcm       push.Sender
	apns      apns.Sender
	tokenRepo repository.PushTokenRepository
	users     pushUserLookup
	presence  pushPresence
	reads     pushReadState

	dmDelay        time.Duration
	readRetraction bool

	sem         chan struct{}
	fcmBreaker  *breaker.Breaker
	apnsBreaker *breaker.Breaker

	pending  atomic.Int64 // deferred timers waiting to fire
	queued   atomic.Int64 // goroutines waiting for a dispatch slot
	inFlight atomic.Int64
	sent     atomic.Int64
	supp     atomic.Int64
	failed   atomic.Int64
	shed     atomic.Int64

	mu        sync.Mutex
	saturated bool // outstanding hit its cap and dropped records; retract unconditionally
	// outstanding tracks the conversations that currently have a notification sitting on one of
	// the user's devices. Without it we fire a retraction push for every read of every
	// conversation, including the ones that were never notified in the first place — which is
	// most of them, and which is exactly the traffic that overflows FCM's queue for an offline
	// device and takes the real call notifications down with it.
	outstanding map[string]struct{}
}

func NewPushService(
	fcm push.Sender,
	apnsSender apns.Sender,
	tokenRepo repository.PushTokenRepository,
	users pushUserLookup,
	presence pushPresence,
	reads pushReadState,
	cfg config.PushConfig,
) PushNotifier {
	maxConcurrent := cfg.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = 16
	}
	if !fcm.Enabled() && !apnsSender.Enabled() {
		log.Printf("[push] disabled: no FCM credentials and no APNs key configured")
	}
	return &pushService{
		fcm: fcm, apns: apnsSender, tokenRepo: tokenRepo, users: users,
		presence: presence, reads: reads,
		dmDelay:        cfg.DMDelay,
		readRetraction: cfg.ReadRetraction,
		sem:            make(chan struct{}, maxConcurrent),
		fcmBreaker:     breaker.New(cfg.CircuitFailureThreshold, cfg.CircuitWindow, cfg.CircuitOpen),
		apnsBreaker:    breaker.New(cfg.CircuitFailureThreshold, cfg.CircuitWindow, cfg.CircuitOpen),
		outstanding:    make(map[string]struct{}),
	}
}

func (s *pushService) Stats() PushStats {
	return PushStats{
		Sent:       s.sent.Load(),
		Suppressed: s.supp.Load(),
		Failed:     s.failed.Load(),
		Shed:       s.shed.Load(),
		Deferred:   s.pending.Load(),
		InFlight:   s.inFlight.Load(),
		FCMUp:      s.fcmUp(),
		APNsUp:     s.apnsUp(),
	}
}

// configured reports whether push exists at all on this deployment. Distinct from fcmUp/apnsUp:
// "never set up" is not a per-message decision and must not be logged like one.
func (s *pushService) configured() bool { return s.fcm.Enabled() || s.apns.Enabled() }

// fcmUp / apnsUp fold "configured" and "not currently failing" into one question. When the
// breaker is open we skip the token lookup too — that lookup is a database connection, and
// paying for it on the way to a call that is going to time out is how an FCM outage becomes a
// message-send outage.
func (s *pushService) fcmUp() bool  { return s.fcm.Enabled() && s.fcmBreaker.Allow() }
func (s *pushService) apnsUp() bool { return s.apns.Enabled() && s.apnsBreaker.Allow() }

func (s *pushService) suppressed(userID, kind, reason string) {
	s.supp.Add(1)
	log.Printf("[push] skipped user=%s kind=%s reason=%s", userID, kind, reason)
}

// dispatch runs fn on the bounded pool. `sheddable` work is dropped once the backlog is absurd;
// a call never is, because a missed call cannot be caught up on later and a missed DM can.
func (s *pushService) dispatch(userID, kind string, sheddable bool, fn func(context.Context)) {
	if sheddable {
		if s.queued.Load() >= maxQueuedDMPushes {
			s.shed.Add(1)
			log.Printf("[push] skipped user=%s kind=%s reason=%s", userID, kind, reasonShed)
			return
		}
		s.queued.Add(1)
	}
	go func() {
		if sheddable {
			defer s.queued.Add(-1)
		}
		s.sem <- struct{}{}
		defer func() { <-s.sem }()

		s.inFlight.Add(1)
		defer s.inFlight.Add(-1)

		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		defer cancel()
		fn(ctx)
	}()
}

func outstandingKey(userID, dmChannelID string) string { return userID + "|" + dmChannelID }

func (s *pushService) markOutstanding(userID, dmChannelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.outstanding) >= maxTrackedNotifications {
		// Full: this delivery goes unrecorded, so from here on we cannot tell a conversation with
		// nothing on the tray from one we simply failed to write down. Retract unconditionally
		// until the map has drained well clear of the cap.
		s.saturated = true
		return
	}
	s.outstanding[outstandingKey(userID, dmChannelID)] = struct{}{}
}

// hasOutstanding peeks without consuming. The record is only spent once the retraction is
// actually about to go out — see NotifyDMRead.
func (s *pushService) hasOutstanding(userID, dmChannelID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saturated {
		return true
	}
	_, ok := s.outstanding[outstandingKey(userID, dmChannelID)]
	return ok
}

// takeOutstanding consumes the record and reports whether there was one. It ALWAYS deletes: an
// earlier version skipped the delete once the map was full, so the map stuck at exactly the cap
// forever and every read from then on fired an unconditional retraction — the FCM queue overflow
// this map exists to prevent, made permanent until a restart.
func (s *pushService) takeOutstanding(userID, dmChannelID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, ok := s.outstanding[outstandingKey(userID, dmChannelID)]
	delete(s.outstanding, outstandingKey(userID, dmChannelID))

	if s.saturated {
		// Reads drain the map. Once there is real headroom again, trust it.
		if len(s.outstanding) <= maxTrackedNotifications/2 {
			s.saturated = false
		}
		return true // records were dropped while full; we cannot claim there is nothing to pull back
	}
	return ok
}

// restoreOutstanding puts a record back after a retraction failed to send. The notification is
// still on the user's tray; forgetting it would strand it there with nothing left to retry.
func (s *pushService) restoreOutstanding(userID, dmChannelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.outstanding) >= maxTrackedNotifications {
		s.saturated = true
		return
	}
	s.outstanding[outstandingKey(userID, dmChannelID)] = struct{}{}
}

func (s *pushService) NotifyDM(recipientID, senderName, content string, encrypted bool, dmChannelID, senderID, messageID string) {
	// Push not configured at all: a boot-time fact, logged once in NewPushService. Logging it per
	// message would bury the reason= lines this feature exists to make greppable, and on a
	// self-hosted instance without push that is EVERY message.
	if !s.configured() {
		return
	}
	if !s.fcmUp() && !s.apnsUp() {
		s.suppressed(recipientID, "dm", reasonProviderRow)
		return
	}

	// Nothing to wait for: with no socket anywhere the user cannot be reading this, so a delay
	// would only make the notification late. This is also the common mobile case — the app is
	// closed and the phone is in a pocket.
	deferrable := s.dmDelay > 0 && messageID != "" &&
		s.presence != nil && s.reads != nil && s.presence.IsOnline(recipientID)
	if !deferrable || s.pending.Load() >= maxPendingDMPushes {
		s.deliverDM(recipientID, senderName, content, encrypted, dmChannelID, senderID)
		return
	}

	s.pending.Add(1)
	time.AfterFunc(s.dmDelay, func() {
		defer s.pending.Add(-1)

		ctx, cancel := context.WithTimeout(context.Background(), pushTimeout)
		defer cancel()

		read, err := s.reads.HasRead(ctx, recipientID, dmChannelID, messageID)
		if err != nil {
			// Never swallow a notification because a read check failed. Push.
			log.Printf("[push] read check for %s failed, sending anyway: %v", recipientID, err)
		} else if read {
			// Tuning signal for MQVI_PUSH_DM_DELAY: this line firing often means the window is
			// earning its keep. The opposite signal is a burst of dm_read retractions landing
			// just after delivery — that means the window is too short.
			s.suppressed(recipientID, "dm", reasonAlreadyRead)
			return // they really are reading it — the push would be noise
		}
		s.deliverDM(recipientID, senderName, content, encrypted, dmChannelID, senderID)
	})
}

func (s *pushService) deliverDM(recipientID, senderName, content string, encrypted bool, dmChannelID, senderID string) {
	s.dispatch(recipientID, "dm", true, func(ctx context.Context) {
		lang, suppress := s.recipientPush(ctx, recipientID)
		if suppress {
			s.suppressed(recipientID, "dm", reasonDND) // honor "Pause notifications"
			return
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
		var delivered, fcmHadTokens, apnsHadTokens bool
		if s.fcmUp() {
			delivered, fcmHadTokens = s.sendFCM(ctx, recipientID, push.Notification{
				Title:    senderName,
				Body:     body,
				Category: push.CategoryMessage,
				Data:     data,
				Tag:      dmNotificationTag(dmChannelID),
			})
		}
		if s.apnsUp() {
			var apnsDelivered bool
			apnsDelivered, apnsHadTokens = s.sendAPNsAlert(ctx, recipientID, dmNotificationTag(dmChannelID), senderName, body, data)
			delivered = delivered || apnsDelivered
		}

		// "No tokens" is only true once BOTH transports have looked. Reporting it from the FCM
		// path alone said no_tokens for every iOS-only user, while their APNs push went out fine.
		if !fcmHadTokens && !apnsHadTokens {
			s.suppressed(recipientID, "dm", reasonNoTokens)
			return
		}
		if delivered {
			// Remember that something is on their tray, so reading the conversation later is
			// worth a retraction push and reading any OTHER conversation is not.
			s.markOutstanding(recipientID, dmChannelID)
		}
	})
}

// dmNotificationTag names a conversation's notifications so they can be found and cancelled
// later. Android: the FCM notification tag MqviMessagingService cancels on dm_read. iOS: the
// apns-collapse-id, which becomes the delivered notification's identifier — pushDismiss.ts
// matches on it. Must stay in sync with DM_TAG_PREFIX in client/src/utils/pushDismiss.ts.
func dmNotificationTag(dmChannelID string) string {
	return "dm:" + dmChannelID
}

func (s *pushService) NotifyDMRead(userID, dmChannelID string) {
	if !s.readRetraction {
		return // MQVI_PUSH_DM_READ_RETRACTION=false — the tray is swept on next reconnect instead
	}
	if !s.fcmUp() && !s.apnsUp() {
		return // no transport to retract through — the reconnect sweep is the fallback
	}
	// Nothing on their tray for this conversation, so there is nothing to pull back. This is the
	// common case and skipping it is most of the point: a retraction for every read of every
	// conversation is the traffic that overflows FCM's queue for an offline phone.
	if !s.hasOutstanding(userID, dmChannelID) {
		return
	}
	// PEEK above, CONSUME below. Consuming before the dispatch meant a shed retraction left the
	// notification on the tray with the server no longer aware of it — nothing would ever retry.
	s.dispatch(userID, "dm_read", true, func(ctx context.Context) {
		if !s.takeOutstanding(userID, dmChannelID) {
			return // another read got there first
		}
		fcmOK, apnsOK := true, true
		if s.fcmUp() {
			fcmOK = s.sendFCMData(ctx, userID, push.DataMessage{
				Data: map[string]string{
					"type":          "dm_read",
					"dm_channel_id": dmChannelID,
				},
				// Per conversation, so a read of one chat cannot replace the retraction for another.
				CollapseKey: "dm_read:" + dmChannelID,
				// High priority, and it is earned: this only fires when a notification is ACTUALLY on
				// the user's tray (see hasOutstanding), so every one of these does user-visible work —
				// it removes a notification. Normal priority would leave a dozing phone showing a
				// notification for a chat the user already read, for hours, which is the guarantee
				// this push exists to provide.
				HighPriority: true,
			})
		}
		if s.apnsUp() {
			// Best-effort by iOS design: background pushes are throttled and never reach a
			// force-quit app. The reconnect sweep (dismissReadNotifications) is the backstop.
			apnsOK = s.sendAPNsBackground(ctx, userID, map[string]string{
				"type":          "dm_read",
				"dm_channel_id": dmChannelID,
			})
		}
		if !fcmOK || !apnsOK {
			s.restoreOutstanding(userID, dmChannelID)
		}
	})
}

// sendAPNsAlert delivers a user-visible alert push to the recipient's iOS APNs tokens
// (messages/DMs). collapseID becomes the delivered notification's identifier so a later
// read can clear it (see dmNotificationTag). Prunes tokens APNs reports permanently
// invalid. delivered/hadTokens mirror sendFCM — see the no_tokens decision in deliverDM.
func (s *pushService) sendAPNsAlert(ctx context.Context, userID, collapseID, title, body string, data map[string]string) (delivered, hadTokens bool) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return false, false
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
		hadTokens = true
		err := s.apns.SendAlert(ctx, t.Token, collapseID, payload)
		if err == nil {
			s.apnsBreaker.Record(true)
			s.sent.Add(1)
			delivered = true
			continue
		}
		if errors.Is(err, apns.ErrTokenUnregistered) {
			dead = append(dead, t.Token) // a fact about the device, not about APNs
			continue
		}
		s.apnsBreaker.Record(false)
		s.failed.Add(1)
		log.Printf("[push] apns alert to %s: %v", userID, err)
	}
	if len(dead) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
			log.Printf("[push] prune apns tokens: %v", delErr)
		}
	}
	return delivered, hadTokens
}

// sendAPNsBackground posts a silent content-available push to every iOS APNs token the user
// has. Mirrors sendFCMData's "settled" semantics: true means nothing is pending on this
// transport (no tokens, or every send succeeded); false means a send failed and the caller
// should keep the retraction record for a retry.
func (s *pushService) sendAPNsBackground(ctx context.Context, userID string, data map[string]string) bool {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return false
	}

	payload := map[string]any{"aps": map[string]any{"content-available": 1}}
	for k, v := range data {
		payload[k] = v
	}

	ok := true
	var dead []string
	for _, t := range tokens {
		if t.TokenType != models.PushTokenTypeAPNs {
			continue
		}
		err := s.apns.SendBackground(ctx, t.Token, payload)
		if err == nil {
			s.apnsBreaker.Record(true)
			s.sent.Add(1)
			continue
		}
		if errors.Is(err, apns.ErrTokenUnregistered) {
			dead = append(dead, t.Token)
			continue
		}
		s.apnsBreaker.Record(false)
		s.failed.Add(1)
		ok = false
		log.Printf("[push] apns background to %s: %v", userID, err)
	}
	if len(dead) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
			log.Printf("[push] prune apns tokens: %v", delErr)
		}
	}
	return ok
}

func (s *pushService) NotifyCall(receiverID, callerName string, callType models.P2PCallType, callID, callerID string) {
	if !s.configured() {
		return
	}
	// A call is never shed and never deferred — it cannot be caught up on later.
	s.dispatch(receiverID, "call", false, func(ctx context.Context) {
		lang, suppress := s.recipientPush(ctx, receiverID)
		if suppress {
			s.suppressed(receiverID, "call", reasonDND)
			return
		}

		tokens, err := s.tokenRepo.ListByUser(ctx, receiverID)
		if err != nil {
			s.failed.Add(1)
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
		if len(androidFCM) > 0 && s.fcmUp() {
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
			// No collapse key: every incoming call is a distinct event and must never replace
			// another one. High priority because it has to wake a dozing phone and ring it.
			invalid, err := s.fcm.SendData(ctx, androidFCM, push.DataMessage{
				Data:         callData,
				HighPriority: true,
			})
			s.fcmBreaker.Record(err == nil)
			if err != nil {
				s.failed.Add(1)
				log.Printf("[push] call FCM to %s: %v", receiverID, err)
			} else {
				s.sent.Add(1)
				if len(invalid) > 0 {
					if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
						log.Printf("[push] prune fcm tokens: %v", delErr)
					}
				}
			}
		}

		// iOS — APNs VoIP (CallKit). caller_name carried for the native call UI.
		if len(voip) > 0 && s.apnsUp() {
			payload := map[string]any{
				"call_id":     callID,
				"caller_id":   callerID,
				"caller_name": callerName,
				"call_type":   string(callType),
			}
			s.sendVoIP(ctx, receiverID, voip, payload)
		}
	})
}

func (s *pushService) NotifyCallCancel(receiverID, callID, excludeDeviceID string) {
	if !s.fcm.Enabled() && !s.apns.Enabled() {
		return
	}
	// Never shed: a device left ringing for a call that is already over is worse than the load.
	s.dispatch(receiverID, "call_cancel", false, func(ctx context.Context) {
		tokens, err := s.tokenRepo.ListByUser(ctx, receiverID)
		if err != nil {
			s.failed.Add(1)
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
		if len(androidFCM) > 0 && s.fcmUp() {
			invalid, err := s.fcm.SendData(ctx, androidFCM, push.DataMessage{
				Data: map[string]string{"type": "call_cancel", "call_id": callID},
				// Repeated cancels for the same call replace each other instead of queueing.
				// High priority: it dismisses a UI that is ringing right now.
				CollapseKey:  "call_cancel:" + callID,
				HighPriority: true,
			})
			s.fcmBreaker.Record(err == nil)
			if err != nil {
				s.failed.Add(1)
				log.Printf("[push] cancel FCM to %s: %v", receiverID, err)
			} else {
				s.sent.Add(1)
				if len(invalid) > 0 {
					if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
						log.Printf("[push] prune fcm tokens: %v", delErr)
					}
				}
			}
		}

		// iOS — a VoIP push carrying "cancel" so CallManager dismisses the CallKit call.
		if len(voip) > 0 && s.apnsUp() {
			s.sendVoIP(ctx, receiverID, voip, map[string]any{"call_id": callID, "cancel": true})
		}
	})
}

// sendVoIP delivers a VoIP payload to each of the user's PushKit tokens, pruning the ones APNs
// reports permanently dead.
func (s *pushService) sendVoIP(ctx context.Context, userID string, tokens []string, payload map[string]any) {
	var dead []string
	for _, vt := range tokens {
		err := s.apns.SendVoIP(ctx, vt, payload)
		if err == nil {
			s.apnsBreaker.Record(true)
			s.sent.Add(1)
			continue
		}
		if errors.Is(err, apns.ErrTokenUnregistered) {
			// A dead token is a fact about the device, not about APNs — it must not open the
			// breaker, or one uninstalled app would stop pushes for everyone.
			dead = append(dead, vt)
			continue
		}
		s.apnsBreaker.Record(false)
		s.failed.Add(1)
		log.Printf("[push] voip to %s: %v", userID, err)
	}
	if len(dead) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, dead); delErr != nil {
			log.Printf("[push] prune voip tokens: %v", delErr)
		}
	}
}

// sendFCM delivers a notification message to the user's FCM tokens — excluding VoIP
// tokens, which are not FCM-addressable (sending them to FCM would fail and wrongly
// prune them) — pruning any FCM reports as permanently unregistered.
// sendFCMData delivers a data-only message to the user's Android devices. Data-only is
// what reaches MqviMessagingService even when the app is backgrounded or killed — a
// notification payload would be displayed by the FCM SDK instead of handed to our code.
// sendFCMData reports whether the message reached FCM, so a caller holding state that assumes
// delivery (the outstanding-notification record) can put it back when it did not.
func (s *pushService) sendFCMData(ctx context.Context, userID string, m push.DataMessage) bool {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return false
	}

	var androidFCM []string
	for _, t := range tokens {
		if t.TokenType == models.PushTokenTypeFCM && t.Platform == "android" {
			androidFCM = append(androidFCM, t.Token)
		}
	}
	if len(androidFCM) == 0 {
		return true // no Android device to retract from; nothing is pending there
	}

	invalid, err := s.fcm.SendData(ctx, androidFCM, m)
	s.fcmBreaker.Record(err == nil)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] send data to %s: %v", userID, err)
		return false
	}
	s.sent.Add(1)
	if len(invalid) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
			log.Printf("[push] prune %d invalid tokens: %v", len(invalid), delErr)
		}
	}
	return true
}

// sendFCM reports (delivered, hadTokens). delivered says there is now something on the user's tray
// worth retracting later; hadTokens lets the caller decide "no tokens" only once every transport
// has looked.
func (s *pushService) sendFCM(ctx context.Context, userID string, n push.Notification) (delivered, hadTokens bool) {
	tokens, err := s.tokenRepo.ListByUser(ctx, userID)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] list tokens for %s: %v", userID, err)
		return false, false
	}

	var values []string
	for _, t := range tokens {
		if t.TokenType == models.PushTokenTypeFCM {
			values = append(values, t.Token)
		}
	}
	if len(values) == 0 {
		return false, false
	}

	invalid, err := s.fcm.Send(ctx, values, n)
	s.fcmBreaker.Record(err == nil)
	if err != nil {
		s.failed.Add(1)
		log.Printf("[push] send to %s: %v", userID, err)
		return false, true
	}
	s.sent.Add(1)
	if len(invalid) > 0 {
		if delErr := s.tokenRepo.DeleteTokens(ctx, invalid); delErr != nil {
			log.Printf("[push] prune %d invalid tokens: %v", len(invalid), delErr)
		}
	}
	// Every token was dead: nothing was delivered, so nothing is on a tray.
	return len(invalid) < len(values), true
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
