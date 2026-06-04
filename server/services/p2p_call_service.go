package services

import (
	"context"
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

type P2PCallService interface {
	InitiateCall(callerID, receiverID string, callType models.P2PCallType) error
	AcceptCall(userID, callID string) error
	DeclineCall(userID, callID string) error
	EndCall(userID string) error
	RelaySignal(senderID, callID string, signal ws.P2PSignalData) error
	HandleDisconnect(userID string)
	GetUserCall(userID string) *models.P2PCall
	// HasActiveCall reports whether the user is in an ACCEPTED (active) call.
	// Status is read under the lock — no mutable pointer escapes.
	HasActiveCall(userID string) bool
	SetAppLogger(logger P2PAppLogger)
}

type p2pCallService struct {
	friendChecker FriendChecker
	userGetter    UserInfoGetter
	hub           ws.BroadcastAndOnline
	appLogger     P2PAppLogger
	urlSigner     FileURLSigner

	// In-memory state, cleared on server restart.
	activeCalls map[string]*models.P2PCall // callID -> call
	userCalls   map[string]string          // userID -> callID (max 1 call per user)
	ringTimers  map[string]*time.Timer     // callID -> auto-cleanup timer for unanswered ringing calls
	mu          sync.RWMutex
}

// ringingTimeout auto-cleans a call that is never answered. Slightly longer than
// the client-side outgoing timeout so a well-behaved client ends it first; this
// is a server-side backstop against a client that never sends decline/end.
const ringingTimeout = 60 * time.Second

func (s *p2pCallService) SetAppLogger(logger P2PAppLogger) {
	s.appLogger = logger
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
) P2PCallService {
	return &p2pCallService{
		friendChecker: friendChecker,
		userGetter:    userGetter,
		hub:           hub,
		urlSigner:     urlSigner,
		activeCalls:   make(map[string]*models.P2PCall),
		userCalls:     make(map[string]string),
		ringTimers:    make(map[string]*time.Timer),
	}
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
	s.mu.Unlock()

	log.Printf("[p2p] ringing call timed out: %s", callID)
	for _, uid := range []string{call.CallerID, call.ReceiverID} {
		s.hub.BroadcastToUser(uid, ws.Event{
			Op:   ws.OpP2PCallEnd,
			Data: map[string]string{"call_id": callID, "reason": "timeout"},
		})
	}
}

func (s *p2pCallService) InitiateCall(callerID, receiverID string, callType models.P2PCallType) error {
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
		ID:         uuid.New().String(),
		CallerID:   callerID,
		ReceiverID: receiverID,
		CallType:   callType,
		Status:     models.P2PCallStatusRinging,
		CreatedAt:  time.Now().UTC(),
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
	s.mu.Unlock()

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

	broadcast := s.buildBroadcast(call, caller, receiver)

	// Notify both parties
	s.hub.BroadcastToUser(receiverID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})
	s.hub.BroadcastToUser(callerID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})

	return nil
}

func (s *p2pCallService) AcceptCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: only receiver can accept", pkg.ErrForbidden)
	}

	if call.Status != models.P2PCallStatusRinging {
		s.mu.Unlock()
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
	s.userCalls[userID] = callID
	s.stopRingTimer(callID)
	s.mu.Unlock()

	log.Printf("[p2p] call accepted: %s accepted call %s", userID, callID)

	// Notify caller to start WebRTC negotiation
	s.hub.BroadcastToUser(call.CallerID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

// DeclineCall declines an incoming call or cancels an outgoing one.
func (s *p2pCallService) DeclineCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.mu.Unlock()

	log.Printf("[p2p] call declined: %s declined call %s", userID, callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallDecline,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

func (s *p2pCallService) EndCall(userID string) error {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: not in a call", pkg.ErrBadRequest)
	}

	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.mu.Unlock()

	log.Printf("[p2p] call ended: %s ended call %s", userID, callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

// RelaySignal forwards WebRTC signaling data (SDP/ICE) to the other party.
// Server does not inspect the payload.
func (s *p2pCallService) RelaySignal(senderID, callID string, signal ws.P2PSignalData) error {
	// Snapshot under the lock — Status is mutated by AcceptCall, so reading it
	// off the shared *P2PCall after unlocking would be a data race. This removes
	// the race; a benign logical window remains (the call may end between this
	// snapshot and the broadcast below), but the receiving client drops a signal
	// whose call_id no longer matches its active call.
	s.mu.RLock()
	call, exists := s.activeCalls[callID]
	var callerID, receiverID string
	var status models.P2PCallStatus
	if exists {
		callerID, receiverID, status = call.CallerID, call.ReceiverID, call.Status
	}
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
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

// HandleDisconnect cleans up active call when a user's WS connection drops.
func (s *p2pCallService) HandleDisconnect(userID string) {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	s.mu.RUnlock()

	if !exists {
		return
	}

	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return
	}

	delete(s.activeCalls, callID)
	s.removeUserMapping(call.CallerID, callID)
	s.removeUserMapping(call.ReceiverID, callID)
	s.stopRingTimer(callID)
	s.mu.Unlock()

	log.Printf("[p2p] call ended due to disconnect: user=%s, call=%s", userID, callID)
	s.logError(&userID, "P2P call ended due to WS disconnect", map[string]string{
		"call_id": callID,
	})

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID, "reason": "disconnect"},
	})
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
