package services

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"

	"github.com/google/uuid"
)

// ISP interfaces — minimal deps instead of full repositories.

// FriendChecker verifies friendship between two users.
type FriendChecker interface {
	GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error)
}

// UserInfoGetter retrieves user info by ID.
type UserInfoGetter interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
	// GetActiveByID returns the user only if not soft-deleted/tombstone — used to
	// reject new actions targeting deleted users (e.g. P2P call initiation).
	GetActiveByID(ctx context.Context, id string) (*models.User, error)
}

// P2PAppLogger writes structured logs. ISP to avoid circular dependency.
type P2PAppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// CallLogger records a finished call as a DM message. ISP — satisfied by dmService.
// Injected via SetCallLogger (dmService is built after p2pCallService).
type CallLogger interface {
	CreateCallLog(ctx context.Context, callerID, receiverID string, meta models.CallMeta) error
}

type P2PCallService interface {
	// InitiateCall takes the initiating connection's sessionID. The caller may be signed in on
	// several devices and all of them see the outgoing call — but only this one negotiates it.
	InitiateCall(callerID, sessionID, instanceID, deviceID, receiverID string, callType models.P2PCallType) error
	// AcceptCall/DeclineCall/EndCall take the acting connection's identity: the sessionID says
	// which of the user's SOCKETS wins the call, and the deviceID says which INSTALLATION acted
	// so it can be excluded from the "stop ringing" push. Telling the device that just answered
	// to stop ringing is what breaks iOS (see PushNotifier.NotifyCallCancel). The instanceID says
	// which running app it is, so that app alone can take its answered call back after a reconnect.
	AcceptCall(userID, sessionID, instanceID, deviceID, callID string) error
	DeclineCall(userID, instanceID, deviceID, callID string) error
	// EndCallWithKey hangs up for the side whose end key this is; see P2PCall.CallerEndKey.
	EndCallWithKey(callID, key string) error
	EndCall(userID, instanceID, deviceID, wantCallID string) error
	// RelaySignal takes the sending connection: only the two sessions that own the call may
	// signal it. A sibling device is not in the call and its SDP would clobber the live session.
	RelaySignal(senderID, senderSessionID, callID string, signal ws.P2PSignalData) error
	// HandleSessionDisconnect ends the call when the CONNECTION carrying it dies — not when the
	// user's last device goes offline. See the implementation.
	HandleSessionDisconnect(userID, sessionID string, nativeMedia bool)
	// ReleaseReplacedApp ends a call held by an app this device has since restarted.
	ReleaseReplacedApp(userID, instanceID, deviceID, heldCallID string)
	// AdoptCall hands a reloaded page the call its predecessor ran, whose media never stopped.
	AdoptCall(userID, sessionID, instanceID, deviceID, callID, previousInstanceID string) error
	// ResumeCall rebinds a call to the connection that replaced the one it died with, cancelling
	// the teardown that death scheduled. Media is peer-to-peer, so a WebSocket blip is not a
	// hang-up — but the new session must be adopted or its signals would be rejected.
	ResumeCall(userID, sessionID, instanceID, callID string) error
	// EndCallBetween ends userID's call if it is with otherID, as though userID hung up.
	EndCallBetween(userID, otherID string)
	GetUserCall(userID string) *models.P2PCall
	// PendingIncomingCall returns the broadcast for a user's active RINGING incoming
	// call (they are the receiver), or nil — used to re-deliver it on (re)connect.
	PendingIncomingCall(userID string) *models.P2PCallBroadcast
	// HasActiveCall reports whether the user is in an ACCEPTED (active) call.
	// Status is read under the lock — no mutable pointer escapes.
	HasActiveCall(userID string) bool
	SetAppLogger(logger P2PAppLogger)
	SetCallLogger(logger CallLogger)
	SetPushNotifier(n PushNotifier)
}

type p2pCallService struct {
	friendChecker FriendChecker
	userGetter    UserInfoGetter
	hub           ws.BroadcastAndOnline
	appLogger     P2PAppLogger
	callLogger    CallLogger
	pushNotifier  PushNotifier
	urlSigner     FileURLSigner

	// In-memory state, cleared on server restart.
	activeCalls map[string]*models.P2PCall // callID -> call
	userCalls   map[string]string          // userID -> callID (max 1 call per user)
	ringTimers  map[string]*time.Timer     // callID -> auto-cleanup timer for unanswered ringing calls
	// Per participant, not per call: both sides can be away at once, and each return speaks only
	// for itself. A dead socket is not a dead call — the media is peer-to-peer.
	graceTimers map[string]*time.Timer // callID|userID -> teardown timer
	// nativeAbsent marks the grace entries whose socket carried native media (callID|userID).
	nativeAbsent map[string]bool
	graceWindow  time.Duration
	mu           sync.RWMutex
}

// nativeMediaAbsenceCeiling bounds a call whose iOS side has been out of reach (page suspended)
// with nothing else ending it.
const nativeMediaAbsenceCeiling = 4 * time.Hour

// ringingTimeout auto-cleans a call that is never answered. Slightly longer than
// the client-side outgoing timeout (30s) so a well-behaved client ends it first; this
// is a server-side backstop against a client that never sends decline/end.
const ringingTimeout = 35 * time.Second

func (s *p2pCallService) SetAppLogger(logger P2PAppLogger) {
	s.appLogger = logger
}

func (s *p2pCallService) SetCallLogger(logger CallLogger) {
	s.callLogger = logger
}

// logCall writes a call-log DM message (best-effort, async — never blocks call
// teardown). Caller MUST NOT hold s.mu (does DB I/O).
func (s *p2pCallService) logCall(callerID, receiverID string, callType models.P2PCallType, outcome string, durationSec int) {
	if s.callLogger == nil {
		return
	}
	go func() {
		meta := models.CallMeta{
			CallerID:    callerID,
			CallType:    string(callType),
			Outcome:     outcome,
			DurationSec: durationSec,
		}
		if err := s.callLogger.CreateCallLog(context.Background(), callerID, receiverID, meta); err != nil {
			log.Printf("[p2p] call log failed (caller=%s receiver=%s outcome=%s): %v", callerID, receiverID, outcome, err)
		}
	}()
}

// callDurationSec returns whole seconds since the call was accepted, clamped to >= 0.
func callDurationSec(acceptedAt time.Time) int {
	if acceptedAt.IsZero() {
		return 0
	}
	d := int(time.Since(acceptedAt).Seconds())
	if d < 0 {
		return 0
	}
	return d
}

func (s *p2pCallService) logError(userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(models.LogLevelError, models.LogCategoryVoice, userID, nil, message, metadata)
	}
}

func NewP2PCallService(
	friendChecker FriendChecker,
	userGetter UserInfoGetter,
	hub ws.BroadcastAndOnline,
	urlSigner FileURLSigner,
	graceWindow time.Duration,
) P2PCallService {
	return &p2pCallService{
		friendChecker: friendChecker,
		userGetter:    userGetter,
		hub:           hub,
		urlSigner:     urlSigner,
		activeCalls:   make(map[string]*models.P2PCall),
		userCalls:     make(map[string]string),
		ringTimers:    make(map[string]*time.Timer),
		graceTimers:   make(map[string]*time.Timer),
		nativeAbsent:  make(map[string]bool),
		graceWindow:   graceWindow,
	}
}

func graceKey(callID, userID string) string { return callID + "|" + userID }

// stopGraceTimer cancels the teardown pending for ONE participant. Caller holds the lock.
func (s *p2pCallService) stopGraceTimer(callID, userID string) {
	key := graceKey(callID, userID)
	if t, ok := s.graceTimers[key]; ok {
		t.Stop()
		delete(s.graceTimers, key)
	}
	delete(s.nativeAbsent, key)
}

// stopGraceTimers stops both parties' windows when a call ends. Both, not one: the other party
// may be in grace too — one dropped router takes them both out. Caller MUST hold s.mu.
func (s *p2pCallService) stopGraceTimers(call *models.P2PCall) {
	s.stopGraceTimer(call.ID, call.CallerID)
	s.stopGraceTimer(call.ID, call.ReceiverID)
}

// removeUserMapping deletes a user's call mapping only if it still points to
// callID — prevents a stale cleanup from clobbering a mapping that has since
// moved to a newer call (defends the one-call-per-user invariant). Caller MUST
// hold s.mu.
func (s *p2pCallService) removeUserMapping(userID, callID string) {
	if s.userCalls[userID] == callID {
		delete(s.userCalls, userID)
	}
}

// stopRingTimer cancels and drops the ringing-timeout timer for a call.
// Caller MUST hold s.mu.
func (s *p2pCallService) stopRingTimer(callID string) {
	if t, ok := s.ringTimers[callID]; ok {
		t.Stop()
		delete(s.ringTimers, callID)
	}
}

// timeoutRinging fires when a call has been ringing too long. It cleans up only
// if the call is still ringing (accepted/ended calls already cleared their
// timer) and notifies both parties of the missed call.
func (s *p2pCallService) timeoutRinging(callID string) {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists || call.Status != models.P2PCallStatusRinging {
		delete(s.ringTimers, callID)
		s.mu.Unlock()
		return
	}
	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	delete(s.ringTimers, callID)
	s.stopGraceTimers(call)
	s.mu.Unlock()

	log.Printf("[p2p] ringing call timed out: %s", callID)
	for _, uid := range []string{call.CallerID, call.ReceiverID} {
		s.hub.BroadcastToUser(uid, ws.Event{
			Op:   ws.OpP2PCallEnd,
			Data: map[string]string{"call_id": callID, "reason": "timeout"},
		})
	}
	// Nobody acted — the ring simply expired — so no device is exempt.
	s.cancelReceiverPush(call, "")

	s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeMissed, 0)
}

// SetPushNotifier wires the (optional) push notifier. InitiateCall guards on nil,
// so push stays disabled when never set.
func (s *p2pCallService) SetPushNotifier(n PushNotifier) {
	s.pushNotifier = n
}

// actingReceiverDevice returns the device to exempt from the "stop ringing" push: the acting
// device, but only when the actor IS the receiver. A caller cancelling has no receiver device
// to exempt.
func actingReceiverDevice(actorID, actorDeviceID, receiverID string) string {
	if actorID == receiverID {
		return actorDeviceID
	}
	return ""
}

// cancelReceiverPush stops a backgrounded receiver's ring (CallKit / Android call
// notification) when a still-ringing call is torn down by the caller or the ring
// timeout — the WS OpP2PCallEnd can't reach a device that only has the push.
// cancelReceiverPush stops the receiver's push ring, if one was ever sent. Callers read the call
// after the locked section that removed it or moved it out of ringing, so RingPushed is final.
func (s *p2pCallService) cancelReceiverPush(call *models.P2PCall, excludeDeviceID string) {
	if s.pushNotifier != nil && call.RingPushed {
		s.pushNotifier.NotifyCallCancel(call.ReceiverID, call.ID, excludeDeviceID)
	}
}

func (s *p2pCallService) InitiateCall(callerID, sessionID, instanceID, deviceID, receiverID string, callType models.P2PCallType) error {
	if callerID == receiverID {
		return fmt.Errorf("%w: cannot call yourself", pkg.ErrBadRequest)
	}

	if callType != models.P2PCallTypeVoice && callType != models.P2PCallTypeVideo {
		return fmt.Errorf("%w: invalid call type", pkg.ErrBadRequest)
	}

	ctx := context.Background()

	// Both parties must be active. WS handler already rejects deleted users on
	// connect, but a crafted/in-flight WS call from a now-soft-deleted caller
	// or to a deleted receiver shouldn't create call state, mark anyone busy,
	// or emit a no-op broadcast to a deleted recipient.
	if _, err := s.userGetter.GetActiveByID(ctx, callerID); err != nil {
		return fmt.Errorf("%w: caller not available", pkg.ErrForbidden)
	}
	if _, err := s.userGetter.GetActiveByID(ctx, receiverID); err != nil {
		return fmt.Errorf("%w: receiver is no longer available", pkg.ErrNotFound)
	}

	friendship, err := s.friendChecker.GetByPair(ctx, callerID, receiverID)
	if err != nil {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}
	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}

	call := &models.P2PCall{
		ID:               uuid.New().String(),
		CallerID:         callerID,
		CallerSessionID:  sessionID,
		CallerInstanceID: instanceID,
		CallerDeviceID:   deviceID,
		CallerEndKey:     newEndKey(),
		ReceiverID:       receiverID,
		CallType:         callType,
		Status:           models.P2PCallStatusRinging,
		CreatedAt:        time.Now().UTC(),
	}

	// Atomic busy-check + reservation under a single write lock. Checking under
	// RLock then reserving under a later Lock leaves a TOCTOU gap where two
	// concurrent initiates from the same caller both pass the check and overwrite
	// userCalls, orphaning a call in activeCalls.
	s.mu.Lock()
	if _, callerBusy := s.userCalls[callerID]; callerBusy {
		s.mu.Unlock()
		return fmt.Errorf("%w: already in a call", pkg.ErrBadRequest)
	}
	if _, receiverBusy := s.userCalls[receiverID]; receiverBusy {
		s.mu.Unlock()
		// Broadcast outside the lock — no I/O under the mutex.
		s.hub.BroadcastToUser(callerID, ws.Event{
			Op:   ws.OpP2PCallBusy,
			Data: map[string]string{"receiver_id": receiverID},
		})
		return fmt.Errorf("%w: user is busy", pkg.ErrBadRequest)
	}
	s.activeCalls[call.ID] = call
	// Reserve BOTH parties immediately. Reserving only the caller let two callers
	// ring the same idle receiver concurrently; the single-call frontend can't
	// model that, so the receiver would accept one call while its state points at
	// the other. Reserving the receiver makes the second caller get "busy".
	s.userCalls[callerID] = call.ID
	s.userCalls[receiverID] = call.ID
	// Server-side backstop: auto-clean if never answered. Cancelled on
	// accept/decline/end/disconnect. time.AfterFunc is a one-shot (no lingering
	// goroutine); on shutdown it's dropped with the rest of the in-memory state.
	s.ringTimers[call.ID] = time.AfterFunc(ringingTimeout, func() { s.timeoutRinging(call.ID) })
	// The live call is written under the lock from here on (an accept can land any moment).
	announced := *call
	s.mu.Unlock()

	// A block between the first check and the registration found no call to end; recheck now.
	// Nothing is announced yet, so the call is dropped silently.
	if f, err := s.friendChecker.GetByPair(ctx, callerID, receiverID); err != nil || f.Status != models.FriendshipStatusAccepted {
		s.cleanupCall(call.ID)
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}

	log.Printf("[p2p] call initiated: %s -> %s (type=%s, id=%s)", callerID, receiverID, callType, call.ID)

	caller, err := s.userGetter.GetByID(ctx, callerID)
	if err != nil {
		s.cleanupCall(call.ID)
		s.logError(&callerID, "P2P call initiate: caller lookup failed", map[string]string{
			"call_id": call.ID, "error": err.Error(),
		})
		return err
	}
	receiver, err := s.userGetter.GetByID(ctx, receiverID)
	if err != nil {
		s.cleanupCall(call.ID)
		s.logError(&callerID, "P2P call initiate: receiver lookup failed", map[string]string{
			"call_id": call.ID, "receiver_id": receiverID, "error": err.Error(),
		})
		return err
	}

	broadcast := s.buildBroadcast(&announced, caller, receiver)

	// Every device of the receiver rings; every device of the caller shows the outgoing call.
	s.hub.BroadcastToUser(receiverID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})

	// The caller's copy names the session that placed the call. Its OTHER sessions must not
	// treat it as their own: without this they flip to active on accept, call getUserMedia, and
	// send a second SDP offer for the same call — the receiver gets two offers and the media
	// session is clobbered, while a phone in a pocket holds an open microphone.
	callerCopy := broadcast
	callerCopy.InitiatedBy = sessionID
	callerCopy.InitiatedByInstance = instanceID
	callerCopy.EndKey = announced.CallerEndKey
	s.hub.BroadcastToUser(callerID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: callerCopy,
	})

	// Push every device of the receiver — the server can't tell which are backgrounded.
	// Handed over under the lock, and only while still ringing: an end then either came first
	// (no ring, and no cancel for it) or comes after, when the ring gate orders its cancel.
	// NotifyCall only opens the gate and spawns its send; the push service never takes s.mu.
	s.mu.Lock()
	current, stillLive := s.activeCalls[call.ID]
	ringing := stillLive && current.Status == models.P2PCallStatusRinging
	if ringing && s.pushNotifier != nil {
		call.RingPushed = true
		s.pushNotifier.NotifyCall(receiverID, pushDisplayName(caller), callType, call.ID, callerID)
	}
	s.mu.Unlock()

	// An end that ran mid-announcement beat the initiate to the clients; repeat it (they ignore extras).
	if !stillLive {
		end := ws.Event{Op: ws.OpP2PCallEnd, Data: map[string]string{"call_id": call.ID}}
		s.hub.BroadcastToUser(receiverID, end)
		s.hub.BroadcastToUser(callerID, end)
	}

	return nil
}

func (s *p2pCallService) AcceptCall(userID, sessionID, instanceID, deviceID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		// An accept re-sent after a reconnect, for a call that ended meanwhile: the end went to
		// the dead socket, so the app is still ringing it.
		s.sendCallState(userID, callID, nil)
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: only receiver can accept", pkg.ErrForbidden)
	}

	// The app that answered, back on a new connection before its accept was confirmed (a phone
	// locked mid-answer). Rejecting it would strand the call with nobody able to reach it. Any
	// other tab or device is rejected below: the call already has a live owner.
	if call.Status == models.P2PCallStatusActive && sameInstance(call.ReceiverInstanceID, instanceID) {
		if call.ReceiverSessionID == sessionID {
			s.mu.Unlock()
			return nil
		}
		call.ReceiverSessionID = sessionID
		s.stopGraceTimer(callID, userID)
		state := *call
		s.mu.Unlock()

		log.Printf("[p2p] call %s answer reclaimed by session %s", callID, sessionID)
		s.sendCallState(userID, callID, &state)
		// The caller's offer went to the dead connection; have it sent again.
		s.hub.BroadcastToUser(state.CallerID, ws.Event{
			Op:   ws.OpP2PSignal,
			Data: ws.P2PSignalData{CallID: callID, Type: "ice-restart"},
		})
		return nil
	}

	if call.Status != models.P2PCallStatusRinging {
		state := *call
		s.mu.Unlock()
		// Answered by another of this user's apps, whose accept this one missed: tell it, or it
		// rings on and its decline would hang up the live call.
		s.sendCallState(userID, callID, &state)
		return fmt.Errorf("%w: call is not ringing", pkg.ErrBadRequest)
	}

	// Reject if the receiver is already in another call — without this, a receiver
	// with two ringing calls could accept both, overwriting userCalls and leaving
	// the first call active-but-orphaned. Checked under the same lock as the write.
	if existing, busy := s.userCalls[userID]; busy && existing != callID {
		s.mu.Unlock()
		return fmt.Errorf("%w: already in a call", pkg.ErrBadRequest)
	}

	call.Status = models.P2PCallStatusActive
	call.AcceptedAt = time.Now().UTC()
	// The call now belongs to this connection. Its death — not the user's last disconnect —
	// is what ends the call (see HandleSessionDisconnect).
	call.ReceiverSessionID = sessionID
	call.ReceiverInstanceID = instanceID
	call.ReceiverDeviceID = deviceID
	call.ReceiverEndKey = newEndKey()
	receiverKey := call.ReceiverEndKey
	s.userCalls[userID] = callID
	s.stopRingTimer(callID)
	s.mu.Unlock()

	log.Printf("[p2p] call accepted: %s accepted call %s", userID, callID)

	// Notify caller to start WebRTC negotiation
	s.hub.BroadcastToUser(call.CallerID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})
	// The receiver's OTHER devices are still ringing on this same event, so name the session
	// that won: it negotiates WebRTC, the rest drop the call. Deciding this on the server is
	// what makes two devices accepting at once safe — the loser's accept is rejected above,
	// but it would still see this broadcast and, if it trusted its own optimism, answer the
	// caller's offer alongside the winner (signalling is user-wide too).
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpP2PCallAccept,
		Data: map[string]string{
			"call_id":              callID,
			"accepted_by":          sessionID,
			"accepted_by_instance": instanceID,
			"end_key":              receiverKey,
		},
	})

	// Sibling devices with no live WS are still ringing on the incoming-call push alone.
	// Never the device that answered: on iOS that push lands on the live call.
	s.cancelReceiverPush(call, deviceID)

	return nil
}

// sameInstance: both known and equal. An unknown one proves nothing about who is asking.
func sameInstance(owner, asking string) bool { return owner != "" && owner == asking }

// DeclineCall declines an incoming call or cancels an outgoing one.
func (s *p2pCallService) DeclineCall(userID, instanceID, deviceID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		// A replay of a decline the app already sent; this settles it.
		s.sendCallState(userID, callID, nil)
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	// A decline only ever means "do not connect this". Once the call is ANSWERED, hanging up is
	// EndCall. Without this guard the most natural gesture there is — answering on the phone and
	// then dismissing the ring still showing on the desktop — destroys the live call and tells
	// the caller it was declined. AcceptCall has always had this check; Decline did not.
	if call.Status != models.P2PCallStatusRinging {
		state := *call
		s.mu.Unlock()
		// The caller cancelled as the answer landed: that is a hang-up, not a stray ring.
		if state.CallerID == userID {
			return s.endCall(userID, instanceID, deviceID, callID, true)
		}
		s.sendCallState(userID, callID, &state)
		return fmt.Errorf("%w: call is not ringing", pkg.ErrBadRequest)
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.stopGraceTimers(call)
	s.mu.Unlock()

	log.Printf("[p2p] call declined: %s declined call %s", userID, callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	// declined_by lets the acting user's own devices tell "I declined this elsewhere"
	// (silent teardown) from "the other party declined" (which is a call-declined toast).
	decline := ws.Event{
		Op:   ws.OpP2PCallDecline,
		Data: map[string]string{"call_id": callID, "declined_by": userID},
	}
	s.hub.BroadcastToUser(otherUserID, decline)
	// The acting user's sibling devices are still showing the call — tear it down there too.
	s.hub.BroadcastToUser(userID, decline)

	// The call was ringing (guarded above), so the receiver's other devices still are — and a
	// backgrounded one has only the push. Never the device that just declined.
	s.cancelReceiverPush(call, actingReceiverDevice(userID, deviceID, call.ReceiverID))

	// The receiver declining is "declined"; the caller cancelling is "missed". A completed call
	// cannot reach here any more — it is not ringing.
	switch {
	case userID == call.ReceiverID:
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeDeclined, 0)
	default:
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeMissed, 0)
	}

	return nil
}

// EndCall hangs up. wantCallID may be empty (an old client sends no id); when set it must match
// the call the user is actually in — a late "end" from a sibling device, or from the 30s outgoing
// timeout, would otherwise kill whatever call the user has started since.
func (s *p2pCallService) EndCall(userID, instanceID, deviceID, wantCallID string) error {
	return s.endCall(userID, instanceID, deviceID, wantCallID, true)
}

// endCall is EndCall with the call log optional: a call ended by a block must not write a
// record into the conversation with the person just blocked.
func (s *p2pCallService) endCall(userID, instanceID, deviceID, wantCallID string, writeLog bool) error {
	s.mu.Lock()
	callID, exists := s.userCalls[userID]
	if !exists || (wantCallID != "" && wantCallID != callID) {
		s.mu.Unlock()
		// A replay of an end the app already sent, for a call that is over for this user; this
		// settles it.
		if wantCallID != "" {
			s.sendCallState(userID, wantCallID, nil)
		}
		if !exists {
			return fmt.Errorf("%w: not in a call", pkg.ErrBadRequest)
		}
		return fmt.Errorf("%w: not the call you are in", pkg.ErrBadRequest)
	}

	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	// An answered call is hung up by the app holding it. Another tab or device of the same user
	// is not in it: its end is one that missed the answer (a stale ring, a logout), not a hang-up.
	owner := call.ReceiverInstanceID
	if call.CallerID == userID {
		owner = call.CallerInstanceID
	}
	if call.Status == models.P2PCallStatusActive && owner != "" && instanceID != "" && owner != instanceID {
		state := *call
		s.mu.Unlock()
		s.sendCallState(userID, callID, &state)
		return fmt.Errorf("%w: this app is not in the call", pkg.ErrForbidden)
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.stopGraceTimers(call)
	s.mu.Unlock()

	log.Printf("[p2p] call ended: %s ended call %s", userID, callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	end := ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID, "ended_by": userID},
	}
	s.hub.BroadcastToUser(otherUserID, end)
	// A caller who hangs up on one device leaves the outgoing call ringing on their others.
	s.hub.BroadcastToUser(userID, end)

	// Hanging up while still ringing: stop the receiver's devices, including any that
	// are backgrounded and ringing on the push alone.
	if call.Status == models.P2PCallStatusRinging {
		s.cancelReceiverPush(call, actingReceiverDevice(userID, deviceID, call.ReceiverID))
	}

	if !writeLog {
		return nil
	}
	if call.Status == models.P2PCallStatusActive {
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeCompleted, callDurationSec(call.AcceptedAt))
	} else {
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeMissed, 0)
	}

	return nil
}

// EndCallBetween ends userID's call with otherID as if userID hung up. P2P media would outlast a block.
func (s *p2pCallService) EndCallBetween(userID, otherID string) {
	s.mu.RLock()
	callID, inCall := s.userCalls[userID]
	withOther := false
	if inCall {
		if call, ok := s.activeCalls[callID]; ok {
			withOther = call.CallerID == otherID || call.ReceiverID == otherID
		}
	}
	s.mu.RUnlock()
	if !withOther {
		return
	}
	// EndCall re-checks under its own lock that userID is still in this call, so a call that
	// ended in between is left alone. No device acted, so none is exempt from the cancel push.
	// The server acts here, not an app: no instance, so no ownership check.
	if err := s.endCall(userID, "", "", callID, false); err != nil {
		log.Printf("[p2p] end call %s between %s and %s: %v", callID, userID, otherID, err)
	}
}

// RelaySignal forwards WebRTC signaling data (SDP/ICE) to the other party.
// Server does not inspect the payload.
func (s *p2pCallService) RelaySignal(senderID, senderSessionID, callID string, signal ws.P2PSignalData) error {
	// Snapshot under the lock — Status is mutated by AcceptCall, so reading it
	// off the shared *P2PCall after unlocking would be a data race. This removes
	// the race; a benign logical window remains (the call may end between this
	// snapshot and the broadcast below), but the receiving client drops a signal
	// whose call_id no longer matches its active call.
	s.mu.RLock()
	call, exists := s.activeCalls[callID]
	var callerID, receiverID, callerSession, receiverSession string
	var status models.P2PCallStatus
	if exists {
		callerID, receiverID, status = call.CallerID, call.ReceiverID, call.Status
		callerSession, receiverSession = call.CallerSessionID, call.ReceiverSessionID
	}
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	// A call is between two CONNECTIONS. A sibling device of either party is not in it, and a
	// signal from one would be relayed as if it were — the other end takes it as a renegotiation
	// and answers against the wrong peer's SDP, clobbering the live media session.
	if senderSessionID != callerSession && senderSessionID != receiverSession {
		return fmt.Errorf("%w: this session is not in the call", pkg.ErrForbidden)
	}

	if callerID != senderID && receiverID != senderID {
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	// Only relay WebRTC signaling once the call is accepted. Forwarding SDP/ICE
	// during ringing lets a caller drive negotiation before the callee consents.
	if status != models.P2PCallStatusActive {
		return fmt.Errorf("%w: call is not active", pkg.ErrBadRequest)
	}

	otherUserID := callerID
	if callerID == senderID {
		otherUserID = receiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PSignal,
		Data: signal,
	})

	return nil
}

// HandleSessionDisconnect ends the call when the CONNECTION carrying it dies.
//
// Keying this on the user's LAST disconnect — as it used to — meant a call-carrying socket
// dropping while any other device stayed signed in tore down nothing: an accepted call has no
// ring timer, so it stayed Active forever and both parties were permanently "already in a call".
// A sibling device dropping is not the call dropping, and only the session that owns the call
// can end it by dying.
func (s *p2pCallService) HandleSessionDisconnect(userID, sessionID string, nativeMedia bool) {
	s.mu.Lock()
	callID, exists := s.userCalls[userID]
	if !exists {
		s.mu.Unlock()
		return
	}
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return
	}

	// A receiver whose socket drops while the call is still RINGING may be a mobile client
	// backgrounding to answer from its push notification. Keep the call alive so reconnect +
	// PendingIncomingCall can re-deliver it; the ring timer still times it out (ringingTimeout). No
	// receiver session owns a ringing call yet — every one of their devices is still ringing.
	if call.Status == models.P2PCallStatusRinging && call.ReceiverID == userID {
		s.mu.Unlock()
		return
	}

	owner := call.CallerSessionID
	if call.ReceiverID == userID {
		owner = call.ReceiverSessionID
	}
	// An empty owner means the call predates session ownership — fall back to the old behaviour
	// (any disconnect of this user ends it) rather than leaking the call.
	if owner != "" && owner != sessionID {
		s.mu.Unlock()
		return // a sibling device dropped; the one in the call is still here
	}

	// The socket carrying the call died — but WebRTC media is peer-to-peer and still flowing, and
	// a call still ringing can still be answered. This is a network blip, not a hang-up. Give the
	// owner a window to reconnect and reclaim the call (p2p_call_resume); tear it down only if
	// nobody does. A ringing call's own timer still bounds it. A zero window disables this.
	// An iOS app's page is suspended whenever it is in the background while its native media
	// runs on, so its socket's death says nothing: the call ends by hang-up, by the media failing
	// (native watches it), or by the app restarting (ReleaseReplacedApp); the ceiling is a backstop.
	window := s.graceWindow
	if nativeMedia {
		window = nativeMediaAbsenceCeiling
	}
	if window > 0 {
		key := graceKey(callID, userID)
		s.stopGraceTimer(callID, userID)
		s.graceTimers[key] = time.AfterFunc(window, func() {
			s.endCallAfterGrace(userID, sessionID, callID)
		})
		if nativeMedia {
			s.nativeAbsent[key] = true
		}
		s.mu.Unlock()
		log.Printf("[p2p] call %s owner %s dropped; %s to reconnect", callID, userID, window)
		return
	}

	s.teardownLocked(userID, callID, call)
}

// ReleaseReplacedApp runs when an app connects. If this user's call is held by another app on the
// same device whose native-media socket is already gone, that app was killed or restarted and
// cannot hold the call's media any more. Only a native-media owner qualifies: iOS runs one app
// per device, while two windows of one desktop install share the device and can both be alive.
func (s *p2pCallService) ReleaseReplacedApp(userID, instanceID, deviceID, heldCallID string) {
	if instanceID == "" || deviceID == "" {
		return
	}
	s.mu.Lock()
	callID, exists := s.userCalls[userID]
	call := s.activeCalls[callID]
	// Only the web page died: the native media still runs, and the new page adopts the call.
	if !exists || call == nil || callID == heldCallID {
		s.mu.Unlock()
		return
	}
	ownerInstance, ownerDevice := call.ReceiverInstanceID, call.ReceiverDeviceID
	if call.CallerID == userID {
		ownerInstance, ownerDevice = call.CallerInstanceID, call.CallerDeviceID
	}
	if ownerDevice != deviceID || ownerInstance == "" || ownerInstance == instanceID ||
		!s.nativeAbsent[graceKey(callID, userID)] {
		s.mu.Unlock()
		return
	}
	log.Printf("[p2p] call %s held by an app this device replaced; ending", callID)
	s.teardownLocked(userID, callID, call)
}

// AdoptCall hands a reloaded iOS page the answered call its predecessor ran. WKWebView's page
// process can be killed in the background while the call's native media runs on; the new page is
// a new app instance on the same device. Anything else is told where the call stands.
func (s *p2pCallService) AdoptCall(userID, sessionID, instanceID, deviceID, callID, previousInstanceID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		s.sendCallState(userID, callID, nil)
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}
	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not a participant", pkg.ErrForbidden)
	}
	isCaller := call.CallerID == userID
	owner, ownerDevice := call.ReceiverInstanceID, call.ReceiverDeviceID
	if isCaller {
		owner, ownerDevice = call.CallerInstanceID, call.CallerDeviceID
	}
	// A repeat from the page that already adopted it is answered again, in case the answer was lost.
	adoptable := owner == previousInstanceID || owner == instanceID
	if call.Status != models.P2PCallStatusActive || instanceID == "" || !adoptable || ownerDevice != deviceID {
		state := *call
		s.mu.Unlock()
		s.sendCallState(userID, callID, &state)
		return fmt.Errorf("%w: this app cannot take the call", pkg.ErrForbidden)
	}
	if isCaller {
		call.CallerSessionID, call.CallerInstanceID = sessionID, instanceID
	} else {
		call.ReceiverSessionID, call.ReceiverInstanceID = sessionID, instanceID
	}
	s.stopGraceTimer(callID, userID)
	state := *call
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	caller, err := s.userGetter.GetByID(ctx, state.CallerID)
	if err != nil {
		return fmt.Errorf("adopt call %s: caller lookup: %w", callID, err)
	}
	receiver, err := s.userGetter.GetByID(ctx, state.ReceiverID)
	if err != nil {
		return fmt.Errorf("adopt call %s: receiver lookup: %w", callID, err)
	}
	bc := s.buildBroadcast(&state, caller, receiver)
	acceptedAt := state.AcceptedAt
	bc.AcceptedAt = &acceptedAt
	log.Printf("[p2p] call %s adopted by user=%s session=%s", callID, userID, sessionID)
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpP2PCallAdopted, Data: bc})
	return nil
}

// endCallAfterGrace fires when this participant never came back. It re-verifies everything under
// the lock: while it was pending the other party may have hung up (the call is gone), or this one
// may have reconnected and taken it over (a different session owns it now).
func (s *p2pCallService) endCallAfterGrace(userID, deadSessionID, callID string) {
	s.mu.Lock()
	delete(s.graceTimers, graceKey(callID, userID))

	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return // already ended by the other party
	}

	owner := call.CallerSessionID
	if call.ReceiverID == userID {
		owner = call.ReceiverSessionID
	}
	if owner != deadSessionID {
		s.mu.Unlock()
		return // reclaimed by a new connection — this timer is stale
	}

	log.Printf("[p2p] call %s not reclaimed in time; ending", callID)
	s.teardownLocked(userID, callID, call)
}

// teardownLocked ends the call and releases the lock. Caller holds it.
func (s *p2pCallService) teardownLocked(userID, callID string, call *models.P2PCall) {
	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.stopGraceTimers(call)
	s.mu.Unlock()

	log.Printf("[p2p] call ended due to disconnect: user=%s, call=%s", userID, callID)
	s.logError(&userID, "P2P call ended due to WS disconnect", map[string]string{
		"call_id": callID,
	})

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	disconnect := ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID, "reason": "disconnect"},
	}
	s.hub.BroadcastToUser(otherUserID, disconnect)
	// The dropped user may still have other devices signed in, showing a call the server has
	// now torn down.
	s.hub.BroadcastToUser(userID, disconnect)

	// A ringing call torn down here means the caller dropped (a ringing receiver drop
	// returns early above) — stop the backgrounded receiver's push ring. No device acted,
	// so none is exempt.
	if call.Status == models.P2PCallStatusRinging {
		s.cancelReceiverPush(call, "")
	}

	if call.Status == models.P2PCallStatusActive {
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeCompleted, callDurationSec(call.AcceptedAt))
	} else {
		s.logCall(call.CallerID, call.ReceiverID, call.CallType, models.CallOutcomeMissed, 0)
	}
}

// ResumeCall rebinds a call to the connection that just replaced the one carrying it, and cancels
// the teardown that its death scheduled.
//
// The rebind is not bookkeeping: RelaySignal rejects a signal whose sender session is neither the
// caller's nor the receiver's, and the session id changes on every reconnect. Without it the ICE
// restart that recovers the media after a blip would be refused.
func (s *p2pCallService) ResumeCall(userID, sessionID, instanceID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		// It ended while this app was cut off, and the end went to the dead socket.
		s.sendCallState(userID, callID, nil)
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}
	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not a participant", pkg.ErrForbidden)
	}
	// A receiver's ringing call has no owning session yet — every one of their devices is still
	// being offered it. It is there, and that is all this app needed to know.
	if call.ReceiverID == userID && call.Status != models.P2PCallStatusActive {
		s.mu.Unlock()
		return nil
	}

	owner := call.ReceiverInstanceID
	if call.CallerID == userID {
		owner = call.CallerInstanceID
	}
	// Another tab or device of this user is not in the call. An owner that predates instance ids
	// cannot be told apart, and keeps the old behaviour.
	isOwner := owner == "" || owner == instanceID
	if isOwner {
		if call.CallerID == userID {
			call.CallerSessionID = sessionID
		} else {
			call.ReceiverSessionID = sessionID
		}
		// Only THIS participant's teardown. Coming back speaks for me, not for the other party —
		// if their socket is also dead, their own window keeps counting down.
		s.stopGraceTimer(callID, userID)
	}
	state := *call
	s.mu.Unlock()

	// Whatever the app missed while cut off (an answer, above all), it gets the call as it is now.
	s.sendCallState(userID, callID, &state)
	if !isOwner {
		return fmt.Errorf("%w: this app is not in the call", pkg.ErrForbidden)
	}
	log.Printf("[p2p] call %s reclaimed by user=%s session=%s", callID, userID, sessionID)
	return nil
}

// sendCallState tells a user's apps where a call stands, for one that may have missed events on a
// dead socket: gone is an end, answered is the accept naming who holds it, ringing needs nothing.
// Every app already handles a repeat of either. Called without s.mu; call is a snapshot or nil.
func (s *p2pCallService) sendCallState(userID, callID string, call *models.P2PCall) {
	switch {
	case call == nil:
		s.hub.BroadcastToUser(userID, ws.Event{
			Op:   ws.OpP2PCallEnd,
			Data: map[string]string{"call_id": callID},
		})
	case call.Status == models.P2PCallStatusActive:
		data := map[string]string{
			"call_id":              callID,
			"accepted_by":          call.ReceiverSessionID,
			"accepted_by_instance": call.ReceiverInstanceID,
		}
		// The asking user's own key: an app whose confirmation was lost never got it.
		key := call.ReceiverEndKey
		if call.CallerID == userID {
			key = call.CallerEndKey
		}
		if key != "" {
			data["end_key"] = key
		}
		s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpP2PCallAccept, Data: data})
	}
}

// newEndKey is 256 random bits; empty only if the system random source fails, which leaves that
// side without the socketless hang-up rather than with a guessable one.
func newEndKey() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Printf("[p2p] end key: %v", err)
		return ""
	}
	return hex.EncodeToString(b)
}

// EndCallWithKey is the hang-up of an app whose page is suspended (iOS in the background): its
// native layer has no socket, only the key this side was given. It ends the call as that side's
// owning app would, so another user's call can never be touched.
func (s *p2pCallService) EndCallWithKey(callID, key string) error {
	if key == "" {
		return fmt.Errorf("%w: no key", pkg.ErrUnauthorized)
	}
	s.mu.RLock()
	call, exists := s.activeCalls[callID]
	var userID, instanceID string
	if exists {
		switch {
		case subtle.ConstantTimeCompare([]byte(call.CallerEndKey), []byte(key)) == 1:
			userID, instanceID = call.CallerID, call.CallerInstanceID
		case subtle.ConstantTimeCompare([]byte(call.ReceiverEndKey), []byte(key)) == 1:
			userID, instanceID = call.ReceiverID, call.ReceiverInstanceID
		}
	}
	s.mu.RUnlock()
	if userID == "" {
		return fmt.Errorf("%w: no such call", pkg.ErrNotFound)
	}
	return s.endCall(userID, instanceID, "", callID, true)
}

// GetUserCall returns the user's active call, or nil if not in a call.
func (s *p2pCallService) GetUserCall(userID string) *models.P2PCall {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	if !exists {
		s.mu.RUnlock()
		return nil
	}
	call := s.activeCalls[callID]
	s.mu.RUnlock()
	return call
}

// HasActiveCall reports whether the user is in an accepted (active) call.
// A ringing/outgoing call is NOT enough — this gates TURN credential issuance
// so a caller cannot mint relay credentials before the callee accepts. The
// status is checked under the lock and only a bool escapes (no data race on the
// shared *P2PCall that AcceptCall mutates).
func (s *p2pCallService) HasActiveCall(userID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	callID, exists := s.userCalls[userID]
	if !exists {
		return false
	}
	call := s.activeCalls[callID]
	return call != nil && call.Status == models.P2PCallStatusActive
}

// cleanupCall removes call state on error.
func (s *p2pCallService) cleanupCall(callID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, exists := s.activeCalls[callID]
	if !exists {
		return
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.stopGraceTimers(call)
}

// PendingIncomingCall re-delivers a ringing incoming call to a receiver who
// connects after missing the live event (was offline, or tapped a push). Returns
// nil unless the user is the receiver of a still-ringing call.
func (s *p2pCallService) PendingIncomingCall(userID string) *models.P2PCallBroadcast {
	// Snapshot the call under the lock — the live pointer can be mutated concurrently.
	s.mu.RLock()
	var call *models.P2PCall
	if callID, ok := s.userCalls[userID]; ok {
		if c := s.activeCalls[callID]; c != nil {
			snapshot := *c
			call = &snapshot
		}
	}
	s.mu.RUnlock()

	if call == nil || call.Status != models.P2PCallStatusRinging || call.ReceiverID != userID {
		return nil
	}

	ctx := context.Background()
	caller, err := s.userGetter.GetByID(ctx, call.CallerID)
	if err != nil {
		return nil
	}
	receiver, err := s.userGetter.GetByID(ctx, call.ReceiverID)
	if err != nil {
		return nil
	}
	bc := s.buildBroadcast(call, caller, receiver)
	return &bc
}

func (s *p2pCallService) buildBroadcast(call *models.P2PCall, caller, receiver *models.User) models.P2PCallBroadcast {
	return models.P2PCallBroadcast{
		ID:                  call.ID,
		CallerID:            call.CallerID,
		CallerUsername:      caller.Username,
		CallerDisplayName:   caller.DisplayName,
		CallerAvatarURL:     s.urlSigner.SignURLPtr(caller.AvatarURL),
		ReceiverID:          call.ReceiverID,
		ReceiverUsername:    receiver.Username,
		ReceiverDisplayName: receiver.DisplayName,
		ReceiverAvatarURL:   s.urlSigner.SignURLPtr(receiver.AvatarURL),
		CallType:            call.CallType,
		Status:              call.Status,
		CreatedAt:           call.CreatedAt,
	}
}
