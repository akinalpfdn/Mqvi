// Package services — BlockService: kullanıcı engelleme iş mantığı.
//
// Engelleme friendships tablosundaki "blocked" status'unu kullanır — ayrı tablo yok.
// Block: Mevcut arkadaşlık/istek varsa sil → "blocked" kayıt oluştur.
// user_id = blocker (engeli koyan), friend_id = target (engellenen).
//
// Bidirectional enforcement: A→B block = A→B ve B→A mesaj engeli.
// IsBlocked çift yönlü kontrol yapar — DM mesaj gönderiminde kullanılır.
//
// BlockChecker ISP: dmService block kontrolü için minimal interface kullanır,
// böylece tam BlockService'e bağımlı olmaz.
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

// BlockService, kullanıcı engelleme işlemleri.
type BlockService interface {
	// BlockUser, bir kullanıcıyı engeller.
	// Mevcut arkadaşlık/istek varsa sil, "blocked" kayıt oluştur.
	BlockUser(ctx context.Context, blockerID, targetID string) error

	// UnblockUser, bir kullanıcının engelini kaldırır.
	// Sadece engelleyen taraf kaldırabilir.
	UnblockUser(ctx context.Context, blockerID, targetID string) error

	// ListBlocked, kullanıcının engellediği kullanıcıları döner.
	ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)

	// IsBlocked, iki kullanıcı arasında herhangi bir yönde engel var mı kontrol eder.
	// BlockChecker ISP'yi de sağlar.
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

// BlockChecker, dmService ve diğer servislerin block kontrolü için kullandığı
// minimal interface (Interface Segregation Principle).
// Tam BlockService'e bağımlılık oluşturmaz.
type BlockChecker interface {
	IsBlocked(ctx context.Context, userA, userB string) (bool, error)
}

type blockService struct {
	friendRepo repository.FriendshipRepository
	userRepo   repository.UserRepository
	hub        ws.Broadcaster
}

// NewBlockService, constructor.
func NewBlockService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
) BlockService {
	return &blockService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		hub:        hub,
	}
}

// BlockUser, bir kullanıcıyı engeller.
//
// Akış:
// 1. Kendini engelleme yasak
// 2. Hedef kullanıcı var mı kontrol et
// 3. Mevcut kayıt (pending/accepted) varsa sil
// 4. Zaten blocked ise hata döndür
// 5. Yeni "blocked" kayıt oluştur (user_id = blocker)
// 6. Her iki tarafa WS broadcast
func (s *blockService) BlockUser(ctx context.Context, blockerID, targetID string) error {
	if blockerID == targetID {
		return fmt.Errorf("%w: cannot block yourself", pkg.ErrBadRequest)
	}

	// Hedef var mı?
	if _, err := s.userRepo.GetByID(ctx, targetID); err != nil {
		return fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	// Mevcut kayıt kontrol et
	existing, err := s.friendRepo.GetByPair(ctx, blockerID, targetID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return err
	}

	if existing != nil {
		if existing.Status == models.FriendshipStatusBlocked {
			// Zaten blocked — ama ben mi bloklamışım?
			if existing.UserID == blockerID {
				return fmt.Errorf("%w: user already blocked", pkg.ErrAlreadyExists)
			}
			// Karşı taraf beni zaten bloklamış — yeni bir blocked kayıt ekle
			// (bidirectional blocking: her iki taraf da ayrı ayrı engelleyebilir)
			// Ama aynı pair'de tek kayıt olabilir — bu durumda mevcut kaydı silip yeniden oluştur
			if err := s.friendRepo.Delete(ctx, existing.ID); err != nil {
				return err
			}
		} else {
			// pending veya accepted — sil, sonra blocked oluştur
			if err := s.friendRepo.Delete(ctx, existing.ID); err != nil {
				return err
			}

			// Karşı tarafa arkadaşlık silindi bildirimi
			otherID := existing.UserID
			if existing.UserID == blockerID {
				otherID = existing.FriendID
			}
			s.hub.BroadcastToUser(otherID, ws.Event{
				Op: ws.OpFriendRemove,
				Data: map[string]string{
					"user_id": blockerID,
				},
			})
		}
	}

	// Yeni "blocked" kayıt oluştur
	now := time.Now().UTC()
	blocked := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    blockerID,
		FriendID:  targetID,
		Status:    models.FriendshipStatusBlocked,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, blocked); err != nil {
		return fmt.Errorf("failed to create block record: %w", err)
	}

	// WS broadcast — her iki tarafa bildir
	s.hub.BroadcastToUser(blockerID, ws.Event{
		Op: ws.OpUserBlock,
		Data: map[string]string{
			"user_id": targetID,
		},
	})
	s.hub.BroadcastToUser(targetID, ws.Event{
		Op: ws.OpUserBlock,
		Data: map[string]string{
			"user_id": blockerID,
		},
	})

	return nil
}

// UnblockUser, bir kullanıcının engelini kaldırır.
// Sadece engelleyen taraf (user_id = me) kaldırabilir.
func (s *blockService) UnblockUser(ctx context.Context, blockerID, targetID string) error {
	existing, err := s.friendRepo.GetByPair(ctx, blockerID, targetID)
	if err != nil {
		return err
	}

	if existing.Status != models.FriendshipStatusBlocked {
		return fmt.Errorf("%w: user is not blocked", pkg.ErrBadRequest)
	}

	// Sadece engelleyen taraf kaldırabilir
	if existing.UserID != blockerID {
		return fmt.Errorf("%w: you can only unblock users you blocked", pkg.ErrForbidden)
	}

	if err := s.friendRepo.Delete(ctx, existing.ID); err != nil {
		return err
	}

	// WS broadcast
	s.hub.BroadcastToUser(blockerID, ws.Event{
		Op: ws.OpUserUnblock,
		Data: map[string]string{
			"user_id": targetID,
		},
	})

	return nil
}

// ListBlocked, kullanıcının engellediği kullanıcıları döner.
func (s *blockService) ListBlocked(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	blocked, err := s.friendRepo.ListBlocked(ctx, userID)
	if err != nil {
		return nil, err
	}

	if blocked == nil {
		blocked = []models.FriendshipWithUser{}
	}
	return blocked, nil
}

// IsBlocked, iki kullanıcı arasında herhangi bir yönde engel var mı.
// Bidirectional: A→B veya B→A yönünde "blocked" kaydı varsa true.
func (s *blockService) IsBlocked(ctx context.Context, userA, userB string) (bool, error) {
	return s.friendRepo.IsBlocked(ctx, userA, userB)
}
