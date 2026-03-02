// Package services — InviteService: davet kodu iş mantığı.
//
// Davet kodu oluşturma, listeleme, silme ve doğrulama (validation).
// Tüm davet kodları sunucu bazlıdır (server_id ile ilişkili).
//
// Kod üretimi: crypto/rand ile 8 byte → hex string → 16 karakter benzersiz kod.
package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// InviteService, davet kodu iş mantığı interface'i.
type InviteService interface {
	// Create, yeni bir davet kodu oluşturur (sunucu bazlı).
	Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error)

	// ListByServer, belirli bir sunucunun davet kodlarını döner.
	ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)

	// Delete, bir davet kodunu siler.
	Delete(ctx context.Context, code string) error

	// ValidateAndUse, davet kodunu doğrular, kullanım sayısını artırır ve invite'ı döner.
	// ServerService.JoinServer tarafından çağrılır — invite'tan server_id alınır.
	ValidateAndUse(ctx context.Context, code string) (*models.Invite, error)

	// IsInviteRequired, belirli bir sunucunun davet kodu gerektirip gerektirmediğini döner.
	IsInviteRequired(ctx context.Context, serverID string) (bool, error)

	// GetPreview, davet kodunun ön izleme bilgisini döner.
	// Auth gerektirmez — invite kartında sunucu bilgisi göstermek için.
	// Süresi dolmuş veya kullanım limiti aşılmış davetler için de preview döner
	// (frontend join denemesinde hata alır ama sunucu adını/ikonunu görebilir).
	GetPreview(ctx context.Context, code string) (*models.InvitePreview, error)
}

type inviteService struct {
	inviteRepo repository.InviteRepository
	serverRepo repository.ServerRepository
}

// NewInviteService, constructor.
func NewInviteService(
	inviteRepo repository.InviteRepository,
	serverRepo repository.ServerRepository,
) InviteService {
	return &inviteService{
		inviteRepo: inviteRepo,
		serverRepo: serverRepo,
	}
}

// Create, yeni bir davet kodu oluşturur.
func (s *inviteService) Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Kod üret: 8 byte rastgele → 16 hex karakter
	codeBytes := make([]byte, 8)
	if _, err := rand.Read(codeBytes); err != nil {
		return nil, fmt.Errorf("failed to generate invite code: %w", err)
	}
	code := hex.EncodeToString(codeBytes)

	invite := &models.Invite{
		Code:      code,
		ServerID:  serverID,
		CreatedBy: createdBy,
		MaxUses:   req.MaxUses,
	}

	// ExpiresIn > 0 ise son kullanma tarihi hesapla
	if req.ExpiresIn > 0 {
		expiresAt := time.Now().Add(time.Duration(req.ExpiresIn) * time.Minute)
		invite.ExpiresAt = &expiresAt
	}

	if err := s.inviteRepo.Create(ctx, invite); err != nil {
		return nil, fmt.Errorf("failed to create invite: %w", err)
	}

	// created_at set edilmediği için DB'den tekrar oku
	created, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("failed to get created invite: %w", err)
	}

	return created, nil
}

// ListByServer, belirli bir sunucunun davet kodlarını döner.
func (s *inviteService) ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error) {
	invites, err := s.inviteRepo.ListByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list invites: %w", err)
	}

	if invites == nil {
		invites = []models.InviteWithCreator{}
	}

	return invites, nil
}

// Delete, bir davet kodunu siler.
func (s *inviteService) Delete(ctx context.Context, code string) error {
	if err := s.inviteRepo.Delete(ctx, code); err != nil {
		return fmt.Errorf("failed to delete invite: %w", err)
	}
	return nil
}

// ValidateAndUse, davet kodunu doğrular, kullanım sayısını artırır ve invite'ı döner.
//
// Dönen *Invite, server_id bilgisini içerir — ServerService.JoinServer
// bu bilgiyle kullanıcıyı doğru sunucuya ekler.
func (s *inviteService) ValidateAndUse(ctx context.Context, code string) (*models.Invite, error) {
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid invite code", pkg.ErrBadRequest)
	}

	// Süre kontrolü
	if invite.ExpiresAt != nil && time.Now().After(*invite.ExpiresAt) {
		return nil, fmt.Errorf("%w: invite code has expired", pkg.ErrBadRequest)
	}

	// Kullanım limiti kontrolü
	if invite.MaxUses > 0 && invite.Uses >= invite.MaxUses {
		return nil, fmt.Errorf("%w: invite code has reached max uses", pkg.ErrBadRequest)
	}

	// Kullanım sayısını artır
	if err := s.inviteRepo.IncrementUses(ctx, code); err != nil {
		return nil, fmt.Errorf("failed to increment invite uses: %w", err)
	}

	return invite, nil
}

// IsInviteRequired, belirli bir sunucunun davet kodu gerektirip gerektirmediğini döner.
func (s *inviteService) IsInviteRequired(ctx context.Context, serverID string) (bool, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return false, fmt.Errorf("failed to get server: %w", err)
	}
	return server.InviteRequired, nil
}

// GetPreview, davet kodunun ön izleme bilgisini döner.
//
// Süresi dolmuş veya kullanım limiti aşılmış davetler dahil — preview döner.
// Böylece kullanıcı sunucu adını/ikonunu görür ama join denemesinde hata alır.
// Yalnızca davet kodu DB'de yoksa ErrNotFound döner.
func (s *inviteService) GetPreview(ctx context.Context, code string) (*models.InvitePreview, error) {
	// 1. Davet kodunu bul
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid invite code", pkg.ErrNotFound)
	}

	// 2. Sunucu bilgisini getir
	server, err := s.serverRepo.GetByID(ctx, invite.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server for invite preview: %w", err)
	}

	// 3. Üye sayısını getir
	memberCount, err := s.serverRepo.GetMemberCount(ctx, invite.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get member count for invite preview: %w", err)
	}

	return &models.InvitePreview{
		ServerName:    server.Name,
		ServerIconURL: server.IconURL,
		MemberCount:   memberCount,
	}, nil
}
