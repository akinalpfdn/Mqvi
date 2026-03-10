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
	SetAppLogger(logger P2PAppLogger)
}

type p2pCallService struct {
	friendChecker FriendChecker
	userGetter    UserInfoGetter
	hub           ws.BroadcastAndOnline
	appLogger     P2PAppLogger

	// In-memory state, cleared on server restart.
	activeCalls map[string]*models.P2PCall // callID -> call
	userCalls   map[string]string          // userID -> callID (max 1 call per user)
	mu          sync.RWMutex
}

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
) P2PCallService {
	return &p2pCallService{
		friendChecker: friendChecker,
		userGetter:    userGetter,
		hub:           hub,
		activeCalls:   make(map[string]*models.P2PCall),
		userCalls:     make(map[string]string),
	}
}

func (s *p2pCallService) InitiateCall(callerID, receiverID string, callType models.P2PCallType) error {
	if callerID == receiverID {
		return fmt.Errorf("%w: cannot call yourself", pkg.ErrBadRequest)
	}

	ctx := context.Background()
	friendship, err := s.friendChecker.GetByPair(ctx, callerID, receiverID)
	if err != nil {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}
	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}

	s.mu.RLock()
	_, callerBusy := s.userCalls[callerID]
	_, receiverBusy := s.userCalls[receiverID]
	s.mu.RUnlock()

	if callerBusy {
		return fmt.Errorf("%w: already in a call", pkg.ErrBadRequest)
	}

	// Send busy signal if receiver is in another call
	if receiverBusy {
		s.hub.BroadcastToUser(callerID, ws.Event{
			Op:   ws.OpP2PCallBusy,
			Data: map[string]string{"receiver_id": receiverID},
		})
		return fmt.Errorf("%w: user is busy", pkg.ErrBadRequest)
	}

	call := &models.P2PCall{
		ID:         uuid.New().String(),
		CallerID:   callerID,
		ReceiverID: receiverID,
		CallType:   callType,
		Status:     models.P2PCallStatusRinging,
		CreatedAt:  time.Now().UTC(),
	}

	s.mu.Lock()
	s.activeCalls[call.ID] = call
	s.userCalls[callerID] = call.ID // Register caller immediately to prevent double-call
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

	call.Status = models.P2PCallStatusActive
	s.userCalls[userID] = callID
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
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
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
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
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
	s.mu.RLock()
	call, exists := s.activeCalls[callID]
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.CallerID != senderID && call.ReceiverID != senderID {
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	otherUserID := call.CallerID
	if call.CallerID == senderID {
		otherUserID = call.ReceiverID
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
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
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

// cleanupCall removes call state on error.
func (s *p2pCallService) cleanupCall(callID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, exists := s.activeCalls[callID]
	if !exists {
		return
	}

	delete(s.activeCalls, callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
}

func (s *p2pCallService) buildBroadcast(call *models.P2PCall, caller, receiver *models.User) models.P2PCallBroadcast {
	return models.P2PCallBroadcast{
		ID:                  call.ID,
		CallerID:            call.CallerID,
		CallerUsername:      caller.Username,
		CallerDisplayName:   caller.DisplayName,
		CallerAvatarURL:     caller.AvatarURL,
		ReceiverID:          call.ReceiverID,
		ReceiverUsername:    receiver.Username,
		ReceiverDisplayName: receiver.DisplayName,
		ReceiverAvatarURL:   receiver.AvatarURL,
		CallType:            call.CallType,
		Status:              call.Status,
		CreatedAt:           call.CreatedAt,
	}
}
