// Package services — P2PCallService: P2P arama iş mantığı.
//
// P2P (peer-to-peer) arama sistemi:
// - Arkadaşlar arası 1-on-1 sesli/görüntülü arama
// - Sunucu sadece signaling relay görevi görür — medya direkt P2P
// - Tüm state ephemeral (in-memory) — DB kaydı yok
//
// In-memory state (VoiceService pattern):
// - activeCalls: callID → *P2PCall
// - userCalls:   userID → callID (her kullanıcı max 1 arama)
// - sync.RWMutex ile concurrent erişim koruması
//
// Signaling akışı:
// 1. Caller → InitiateCall → Server validate → BroadcastToUser(receiver)
// 2. Receiver → AcceptCall → Server update → BroadcastToUser(caller)
// 3. SDP/ICE → RelaySignal → BroadcastToUser(otherUser) (direkt relay)
// 4. Either → EndCall → Server cleanup → BroadcastToUser(other)
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

// ─── ISP Interface'leri ───
//
// Interface Segregation: P2PCallService sadece ihtiyacı olan metotlara bağımlıdır.
// Tam FriendshipRepository veya UserRepository'ye bağlanmak yerine minimal interface'ler kullanılır.

// FriendChecker, iki kullanıcının arkadaş olup olmadığını kontrol eden minimal interface.
// repository.FriendshipRepository bu interface'i duck typing ile otomatik karşılar.
type FriendChecker interface {
	GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error)
}

// UserInfoGetter, kullanıcı bilgisi almak için minimal interface.
// repository.UserRepository bu interface'i duck typing ile otomatik karşılar.
type UserInfoGetter interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// ─── P2PCallService Interface ───

// P2PCallService, P2P arama operasyonları için iş mantığı interface'i.
type P2PCallService interface {
	// InitiateCall, yeni bir P2P arama başlatır.
	// Arkadaşlık ve online kontrolü yapar, receiver'a bildirim gönderir.
	InitiateCall(callerID, receiverID string, callType models.P2PCallType) error

	// AcceptCall, gelen bir aramayı kabul eder.
	// Sadece receiver kabul edebilir. WebRTC negotiation başlar.
	AcceptCall(userID, callID string) error

	// DeclineCall, gelen bir aramayı reddeder veya caller tarafından iptal eder.
	DeclineCall(userID, callID string) error

	// EndCall, aktif bir aramayı sonlandırır.
	// Her iki taraf da sonlandırabilir.
	EndCall(userID string) error

	// RelaySignal, WebRTC signaling verisini (SDP/ICE) karşı tarafa iletir.
	// Server içeriğe bakmaz — doğrudan relay eder.
	RelaySignal(senderID, callID string, signal ws.P2PSignalData) error

	// HandleDisconnect, kullanıcının WS bağlantısı koptuğunda çağrılır.
	// Aktif araması varsa sonlandırır ve karşı tarafa bildirir.
	HandleDisconnect(userID string)

	// GetUserCall, kullanıcının aktif aramasını döner (nil = aramada değil).
	GetUserCall(userID string) *models.P2PCall
}

// p2pCallService, P2PCallService'in private implementasyonu.
type p2pCallService struct {
	friendChecker FriendChecker
	userGetter    UserInfoGetter
	hub           ws.EventPublisher

	// activeCalls: callID → *P2PCall (aktif aramalar)
	// In-memory — sunucu restart'ında temizlenir.
	activeCalls map[string]*models.P2PCall

	// userCalls: userID → callID (her kullanıcı max 1 arama)
	// Hem caller hem receiver için entry eklenir.
	userCalls map[string]string

	// mu: activeCalls ve userCalls'ı koruyan read-write mutex.
	mu sync.RWMutex
}

// NewP2PCallService, constructor. Tüm dependency'ler injection ile alınır.
func NewP2PCallService(
	friendChecker FriendChecker,
	userGetter UserInfoGetter,
	hub ws.EventPublisher,
) P2PCallService {
	return &p2pCallService{
		friendChecker: friendChecker,
		userGetter:    userGetter,
		hub:           hub,
		activeCalls:   make(map[string]*models.P2PCall),
		userCalls:     make(map[string]string),
	}
}

// InitiateCall, yeni bir P2P arama başlatır.
func (s *p2pCallService) InitiateCall(callerID, receiverID string, callType models.P2PCallType) error {
	// 1. Kendini arayamaz
	if callerID == receiverID {
		return fmt.Errorf("%w: cannot call yourself", pkg.ErrBadRequest)
	}

	// 2. Arkadaşlık kontrolü
	ctx := context.Background()
	friendship, err := s.friendChecker.GetByPair(ctx, callerID, receiverID)
	if err != nil {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}
	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}

	// 3. Receiver online mı?
	onlineIDs := s.hub.GetOnlineUserIDs()
	receiverOnline := false
	for _, id := range onlineIDs {
		if id == receiverID {
			receiverOnline = true
			break
		}
	}
	if !receiverOnline {
		// Receiver'a "user offline" gönderemeyiz, caller'a bildir
		s.hub.BroadcastToUser(callerID, ws.Event{
			Op:   ws.OpP2PCallDecline,
			Data: map[string]string{"call_id": "", "reason": "offline"},
		})
		return fmt.Errorf("%w: user is offline", pkg.ErrBadRequest)
	}

	// 4. Caller zaten aramada mı?
	s.mu.RLock()
	_, callerBusy := s.userCalls[callerID]
	_, receiverBusy := s.userCalls[receiverID]
	s.mu.RUnlock()

	if callerBusy {
		return fmt.Errorf("%w: already in a call", pkg.ErrBadRequest)
	}

	// 5. Receiver zaten aramada mı? → meşgul sinyali
	if receiverBusy {
		s.hub.BroadcastToUser(callerID, ws.Event{
			Op:   ws.OpP2PCallBusy,
			Data: map[string]string{"receiver_id": receiverID},
		})
		return fmt.Errorf("%w: user is busy", pkg.ErrBadRequest)
	}

	// 6. Call oluştur
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
	s.userCalls[callerID] = call.ID // Caller hemen kaydedilir (çift arama engeli)
	s.mu.Unlock()

	log.Printf("[p2p] call initiated: %s → %s (type=%s, id=%s)", callerID, receiverID, callType, call.ID)

	// 7. Her iki tarafın kullanıcı bilgilerini al
	caller, err := s.userGetter.GetByID(ctx, callerID)
	if err != nil {
		s.cleanupCall(call.ID)
		return err
	}
	receiver, err := s.userGetter.GetByID(ctx, receiverID)
	if err != nil {
		s.cleanupCall(call.ID)
		return err
	}

	broadcast := s.buildBroadcast(call, caller, receiver)

	// 8. Receiver'a gelen arama bildirimi gönder
	s.hub.BroadcastToUser(receiverID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})

	// 9. Caller'a da call bilgisini gönder (UI güncelleme)
	s.hub.BroadcastToUser(callerID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})

	return nil
}

// AcceptCall, gelen bir aramayı kabul eder.
func (s *p2pCallService) AcceptCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	// Sadece receiver kabul edebilir
	if call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: only receiver can accept", pkg.ErrForbidden)
	}

	if call.Status != models.P2PCallStatusRinging {
		s.mu.Unlock()
		return fmt.Errorf("%w: call is not ringing", pkg.ErrBadRequest)
	}

	// Status güncelle ve receiver'ı da userCalls'a ekle
	call.Status = models.P2PCallStatusActive
	s.userCalls[userID] = callID
	s.mu.Unlock()

	log.Printf("[p2p] call accepted: %s accepted call %s", userID, callID)

	// Caller'a bildir — WebRTC negotiation başlasın
	s.hub.BroadcastToUser(call.CallerID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})

	// Receiver'a da onay gönder
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

// DeclineCall, gelen bir aramayı reddeder veya caller iptal eder.
func (s *p2pCallService) DeclineCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	// Hem caller hem receiver reddedebilir
	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	// Cleanup
	delete(s.activeCalls, callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	s.mu.Unlock()

	log.Printf("[p2p] call declined: %s declined call %s", userID, callID)

	// Diğer tarafa bildir
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

// EndCall, aktif bir aramayı sonlandırır.
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

	// Cleanup
	delete(s.activeCalls, callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	s.mu.Unlock()

	log.Printf("[p2p] call ended: %s ended call %s", userID, callID)

	// Diğer tarafa bildir
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

// RelaySignal, WebRTC signaling verisini karşı tarafa relay eder.
func (s *p2pCallService) RelaySignal(senderID, callID string, signal ws.P2PSignalData) error {
	s.mu.RLock()
	call, exists := s.activeCalls[callID]
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	// Sender bu aramanın bir parçası mı?
	if call.CallerID != senderID && call.ReceiverID != senderID {
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	// Diğer tarafa relay et
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

// HandleDisconnect, kullanıcının WS bağlantısı koptuğunda çağrılır.
// Aktif araması varsa temizler ve karşı tarafa bildirir.
func (s *p2pCallService) HandleDisconnect(userID string) {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	s.mu.RUnlock()

	if !exists {
		return // Aramada değildi, bir şey yapmaya gerek yok
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

	// Diğer tarafa bildir
	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID, "reason": "disconnect"},
	})
}

// GetUserCall, kullanıcının aktif aramasını döner (nil = aramada değil).
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

// cleanupCall, hata durumunda call state'ini temizler.
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

// buildBroadcast, P2PCallBroadcast payload'ı oluşturur.
// Her iki tarafın kullanıcı bilgilerini içerir.
func (s *p2pCallService) buildBroadcast(call *models.P2PCall, caller, receiver *models.User) models.P2PCallBroadcast {
	return models.P2PCallBroadcast{
		ID:                  call.ID,
		CallerID:            call.CallerID,
		CallerUsername:      caller.Username,
		CallerDisplayName:   caller.DisplayName,
		CallerAvatarURL:     caller.AvatarURL,
		ReceiverID:          call.ReceiverID,
		ReceiverUsername:     receiver.Username,
		ReceiverDisplayName: receiver.DisplayName,
		ReceiverAvatarURL:   receiver.AvatarURL,
		CallType:            call.CallType,
		Status:              call.Status,
		CreatedAt:           call.CreatedAt,
	}
}
