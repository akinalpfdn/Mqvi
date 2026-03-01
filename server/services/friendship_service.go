// Package services — FriendshipService: arkadaşlık iş mantığı.
//
// Business logic:
// - İstek gönderme: Kendine istek yollanamaz, zaten kayıt varsa hata döner
// - Kabul etme: Sadece hedef kullanıcı (friend_id) kabul edebilir
// - Reddetme/iptal: Hem gönderen hem alan taraf silebilir
// - Arkadaşlıktan çıkarma: Sadece accepted kaydı olan taraflar
// - Bloklu kullanıcı kontrolü: Bloklanmış kullanıcıya istek gönderilmez
//
// WS broadcast: Hem gönderen hem alan tarafa event gönderilir (BroadcastToUser).
package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"

	"github.com/google/uuid"
)

// FriendshipService, arkadaşlık işlemleri için public interface.
// Handler katmanı bu interface'e bağımlıdır (Dependency Inversion).
type FriendshipService interface {
	// SendRequest, arkadaşlık isteği gönderir.
	// username ile hedef kullanıcıyı bulur, pending kayıt oluşturur.
	SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error)

	// AcceptRequest, gelen bir arkadaşlık isteğini kabul eder.
	// Sadece friend_id (hedef kullanıcı) kabul edebilir.
	AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error)

	// DeclineRequest, gelen bir arkadaşlık isteğini reddeder veya gönderilen isteği iptal eder.
	// Hem user_id hem friend_id silme işlemi yapabilir.
	DeclineRequest(ctx context.Context, userID, requestID string) error

	// RemoveFriend, mevcut arkadaşlığı siler.
	// Sadece accepted durumundaki kayıtlar silinebilir.
	RemoveFriend(ctx context.Context, userID, targetUserID string) error

	// ListFriends, kullanıcının kabul edilmiş arkadaşlarını döner.
	ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// ListRequests, kullanıcıya gelen VE gönderilen bekleyen istekleri döner.
	// incoming + outgoing olarak ayrılmış bir DTO döner.
	ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error)
}

// FriendRequestsResponse, gelen ve giden istekleri ayıran DTO.
type FriendRequestsResponse struct {
	Incoming []models.FriendshipWithUser `json:"incoming"`
	Outgoing []models.FriendshipWithUser `json:"outgoing"`
}

// friendshipService, FriendshipService'in private implementasyonu.
type friendshipService struct {
	friendRepo repository.FriendshipRepository
	userRepo   repository.UserRepository
	hub        ws.Broadcaster
}

// NewFriendshipService, constructor. Tüm dependency'ler injection ile alınır.
func NewFriendshipService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
) FriendshipService {
	return &friendshipService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		hub:        hub,
	}
}

// SendRequest, arkadaşlık isteği gönderir.
func (s *friendshipService) SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error) {
	// 1. Validasyon
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// 2. Hedef kullanıcıyı bul
	target, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
		return nil, err
	}

	// 3. Kendine istek gönderme kontrolü
	if senderID == target.ID {
		return nil, fmt.Errorf("%w: cannot send friend request to yourself", pkg.ErrBadRequest)
	}

	// 4. Mevcut kayıt kontrolü (pending, accepted veya blocked)
	existing, err := s.friendRepo.GetByPair(ctx, senderID, target.ID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return nil, err
	}

	if existing != nil {
		switch existing.Status {
		case models.FriendshipStatusAccepted:
			return nil, fmt.Errorf("%w: already friends with %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusPending:
			// Karşı taraf zaten bana istek göndermiş → otomatik kabul et
			if existing.UserID == target.ID {
				return s.acceptExisting(ctx, existing, senderID)
			}
			return nil, fmt.Errorf("%w: friend request already sent to %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusBlocked:
			// Bloklanmışsa varlığını ifşa etme — genel "not found" döndür
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
	}

	// 5. Yeni pending kayıt oluştur
	now := time.Now().UTC()
	friendship := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    senderID,
		FriendID:  target.ID,
		Status:    models.FriendshipStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, friendship); err != nil {
		return nil, err
	}

	// 6. Gönderen bilgilerini al (broadcast için)
	sender, err := s.userRepo.GetByID(ctx, senderID)
	if err != nil {
		return nil, err
	}

	// Response DTO — hedef kullanıcının bilgileri (sender'a dönecek)
	result := &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           friendship.Status,
		CreatedAt:        friendship.CreatedAt,
		UserID:           target.ID,
		Username:         target.Username,
		DisplayName:      target.DisplayName,
		AvatarURL:        target.AvatarURL,
		UserStatus:       string(target.Status),
		UserCustomStatus: target.CustomStatus,
	}

	// 7. WS broadcast — hedef kullanıcıya bildirim gönder
	s.hub.BroadcastToUser(target.ID, ws.Event{
		Op: ws.OpFriendRequestCreate,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           friendship.Status,
			CreatedAt:        friendship.CreatedAt,
			UserID:           sender.ID,
			Username:         sender.Username,
			DisplayName:      sender.DisplayName,
			AvatarURL:        sender.AvatarURL,
			UserStatus:       string(sender.Status),
			UserCustomStatus: sender.CustomStatus,
		},
	})

	return result, nil
}

// acceptExisting, karşı tarafın zaten gönderdiği isteği otomatik kabul eder.
// "Karşılıklı istek → otomatik arkadaş" senaryosu.
func (s *friendshipService) acceptExisting(ctx context.Context, existing *models.Friendship, acceptorID string) (*models.FriendshipWithUser, error) {
	if err := s.friendRepo.UpdateStatus(ctx, existing.ID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}

	// Her iki tarafa da "accepted" bildirimi gönder
	sender, err := s.userRepo.GetByID(ctx, existing.UserID)
	if err != nil {
		return nil, err
	}
	acceptor, err := s.userRepo.GetByID(ctx, acceptorID)
	if err != nil {
		return nil, err
	}

	// Gönderene bildir: "isteğin kabul edildi"
	s.hub.BroadcastToUser(existing.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               existing.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        existing.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        acceptor.AvatarURL,
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	// Kabul edene dön (sender bilgileri)
	return &models.FriendshipWithUser{
		ID:               existing.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        existing.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        sender.AvatarURL,
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

// AcceptRequest, gelen bir arkadaşlık isteğini kabul eder.
func (s *friendshipService) AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error) {
	// 1. İsteği bul
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return nil, err
	}

	// 2. Sadece hedef kullanıcı (friend_id) kabul edebilir
	if friendship.FriendID != userID {
		return nil, fmt.Errorf("%w: you can only accept requests sent to you", pkg.ErrForbidden)
	}

	// 3. Sadece pending durumundaki istekler kabul edilebilir
	if friendship.Status != models.FriendshipStatusPending {
		return nil, fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	// 4. Status güncelle
	if err := s.friendRepo.UpdateStatus(ctx, requestID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}

	// 5. Gönderenin bilgilerini al
	sender, err := s.userRepo.GetByID(ctx, friendship.UserID)
	if err != nil {
		return nil, err
	}

	// Kabul edenin bilgilerini al (broadcast için)
	acceptor, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	// 6. WS broadcast — gönderene bildir
	s.hub.BroadcastToUser(friendship.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        friendship.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        acceptor.AvatarURL,
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	return &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        friendship.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        sender.AvatarURL,
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

// DeclineRequest, gelen isteği reddeder veya gönderilen isteği iptal eder.
func (s *friendshipService) DeclineRequest(ctx context.Context, userID, requestID string) error {
	// 1. İsteği bul
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return err
	}

	// 2. Yetki kontrolü: sadece gönderen veya alan taraf işlem yapabilir
	if friendship.UserID != userID && friendship.FriendID != userID {
		return fmt.Errorf("%w: not your friend request", pkg.ErrForbidden)
	}

	// 3. Sadece pending durumundaki istekler reddedilebilir
	if friendship.Status != models.FriendshipStatusPending {
		return fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	// 4. Kaydı sil
	if err := s.friendRepo.Delete(ctx, requestID); err != nil {
		return err
	}

	// 5. Karşı tarafa bildir
	otherUserID := friendship.UserID
	if friendship.UserID == userID {
		otherUserID = friendship.FriendID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op: ws.OpFriendRequestDecline,
		Data: map[string]string{
			"id":      requestID,
			"user_id": userID,
		},
	})

	return nil
}

// RemoveFriend, mevcut arkadaşlığı siler.
func (s *friendshipService) RemoveFriend(ctx context.Context, userID, targetUserID string) error {
	// 1. Mevcut arkadaşlık kaydını bul
	friendship, err := s.friendRepo.GetByPair(ctx, userID, targetUserID)
	if err != nil {
		return err
	}

	// 2. Sadece accepted durumundaki kayıtlar silinebilir
	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends with this user", pkg.ErrBadRequest)
	}

	// 3. Kaydı sil
	if err := s.friendRepo.DeleteByPair(ctx, userID, targetUserID); err != nil {
		return err
	}

	// 4. Karşı tarafa bildir
	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpFriendRemove,
		Data: map[string]string{
			"user_id": userID,
		},
	})

	return nil
}

// ListFriends, kullanıcının kabul edilmiş arkadaşlarını döner.
func (s *friendshipService) ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	friends, err := s.friendRepo.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}

	// JSON serialization: null yerine boş array döndür
	if friends == nil {
		friends = []models.FriendshipWithUser{}
	}
	return friends, nil
}

// ListRequests, gelen ve giden istekleri ayrı ayrı döner.
func (s *friendshipService) ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error) {
	incoming, err := s.friendRepo.ListIncoming(ctx, userID)
	if err != nil {
		return nil, err
	}

	outgoing, err := s.friendRepo.ListOutgoing(ctx, userID)
	if err != nil {
		return nil, err
	}

	// JSON serialization: null yerine boş array döndür
	if incoming == nil {
		incoming = []models.FriendshipWithUser{}
	}
	if outgoing == nil {
		outgoing = []models.FriendshipWithUser{}
	}

	return &FriendRequestsResponse{
		Incoming: incoming,
		Outgoing: outgoing,
	}, nil
}
