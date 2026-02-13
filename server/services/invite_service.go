// Package services — InviteService: davet kodu iş mantığı.
//
// Davet kodu oluşturma, listeleme, silme ve doğrulama (validation).
// Register sırasında invite_code doğrulaması AuthService'den çağrılır,
// bu yüzden InviteService'in ValidateAndUse metodu public interface'te yer alır.
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
	// Create, yeni bir davet kodu oluşturur.
	// createdBy: daveti oluşturan kullanıcı ID'si.
	Create(ctx context.Context, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error)

	// List, tüm davet kodlarını oluşturan kullanıcı bilgisiyle döner.
	List(ctx context.Context) ([]models.InviteWithCreator, error)

	// Delete, bir davet kodunu siler.
	Delete(ctx context.Context, code string) error

	// ValidateAndUse, davet kodunu doğrular ve kullanım sayısını artırır.
	// Register sırasında AuthService tarafından çağrılır.
	// Geçersiz / süresi dolmuş / dolmuş kodlar için hata döner.
	ValidateAndUse(ctx context.Context, code string) error

	// IsInviteRequired, sunucunun davet kodu gerektirip gerektirmediğini döner.
	// Register sırasında AuthService tarafından çağrılır.
	IsInviteRequired(ctx context.Context) (bool, error)
}

type inviteService struct {
	inviteRepo repository.InviteRepository
	serverRepo repository.ServerRepository
}

// NewInviteService, constructor.
//
// serverRepo: invite_required ayarını kontrol etmek için gereklidir.
// Kullanıcı kayıt olurken invite_required=true ise davet kodu zorunludur.
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
//
// İş kuralları:
// 1. Request validasyonu
// 2. Benzersiz kod üret (crypto/rand — kriptografik güvenli rastgele sayı)
// 3. Opsiyonel son kullanma tarihi hesapla
// 4. DB'ye kaydet
func (s *inviteService) Create(ctx context.Context, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Kod üret: 8 byte rastgele → 16 hex karakter
	// crypto/rand: Kriptografik güvenli rastgele sayı üretir (math/rand'den farklı).
	// Bu, davet kodlarının tahmin edilemez olmasını sağlar.
	codeBytes := make([]byte, 8)
	if _, err := rand.Read(codeBytes); err != nil {
		return nil, fmt.Errorf("failed to generate invite code: %w", err)
	}
	code := hex.EncodeToString(codeBytes)

	invite := &models.Invite{
		Code:      code,
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

// List, tüm davet kodlarını döner.
func (s *inviteService) List(ctx context.Context) ([]models.InviteWithCreator, error) {
	invites, err := s.inviteRepo.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list invites: %w", err)
	}

	// nil slice yerine boş slice döndür (JSON'da [] olması için, null değil)
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

// ValidateAndUse, davet kodunu doğrular ve kullanım sayısını artırır.
//
// Doğrulama kuralları:
// 1. Kod mevcut mu? (ErrNotFound → geçersiz kod)
// 2. Süresi dolmuş mu? (ExpiresAt < now → expired)
// 3. Maksimum kullanıma ulaşılmış mı? (MaxUses > 0 && Uses >= MaxUses → depleted)
// 4. Tüm kontroller geçerse → uses++ ve nil döner
func (s *inviteService) ValidateAndUse(ctx context.Context, code string) error {
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return fmt.Errorf("%w: invalid invite code", pkg.ErrBadRequest)
	}

	// Süre kontrolü
	if invite.ExpiresAt != nil && time.Now().After(*invite.ExpiresAt) {
		return fmt.Errorf("%w: invite code has expired", pkg.ErrBadRequest)
	}

	// Kullanım limiti kontrolü
	if invite.MaxUses > 0 && invite.Uses >= invite.MaxUses {
		return fmt.Errorf("%w: invite code has reached max uses", pkg.ErrBadRequest)
	}

	// Kullanım sayısını artır
	if err := s.inviteRepo.IncrementUses(ctx, code); err != nil {
		return fmt.Errorf("failed to increment invite uses: %w", err)
	}

	return nil
}

// IsInviteRequired, sunucunun davet kodu gerektirip gerektirmediğini döner.
func (s *inviteService) IsInviteRequired(ctx context.Context) (bool, error) {
	server, err := s.serverRepo.Get(ctx)
	if err != nil {
		return false, fmt.Errorf("failed to get server: %w", err)
	}
	return server.InviteRequired, nil
}
