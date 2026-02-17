// Package services — ChannelPermissionService: kanal bazlı permission override iş mantığı.
//
// Discord'taki gibi, belirli bir kanaldaki rollere özel izin/engelleme tanımlar.
// Her (channel_id, role_id) çifti için allow/deny bit'leri saklanır.
//
// Permission resolution algoritması (Discord):
//
//	base = tüm rollerin permission'larının OR'u
//	channelAllow = kullanıcının rollerine ait override allow'ların OR'u
//	channelDeny  = kullanıcının rollerine ait override deny'ların OR'u
//	effective    = (base & ~channelDeny) | channelAllow
//
// Admin yetkisi tüm override'ları bypass eder.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// ChannelPermResolver, kanal bazlı effective permission hesaplayan ISP interface.
//
// Interface Segregation Principle: MessageService ve VoiceService sadece
// permission resolution'a ihtiyaç duyar, override CRUD'a değil.
// Bu minimal interface sayesinde service'ler birbirine sıkı bağımlı olmaz.
//
// ChannelPermissionService bu interface'i otomatik karşılar (Go duck typing).
type ChannelPermResolver interface {
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
}

// ChannelPermissionService, kanal bazlı permission override yönetimi interface'i.
type ChannelPermissionService interface {
	// GetOverrides, bir kanaldaki tüm permission override'ları döner.
	// Admin panelinde kullanılır — "bu kanalda hangi roller için override var?"
	GetOverrides(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)

	// SetOverride, bir kanal-rol çifti için override oluşturur veya günceller.
	// allow=0, deny=0 ise override'ı siler (inherit'e döner).
	SetOverride(ctx context.Context, channelID, roleID string, req *models.SetOverrideRequest) error

	// DeleteOverride, bir kanal-rol çifti için override'ı kaldırır.
	DeleteOverride(ctx context.Context, channelID, roleID string) error

	// ResolveChannelPermissions, bir kullanıcının belirli bir kanaldaki effective permission'ını hesaplar.
	//
	// Discord algoritması:
	// 1. Kullanıcının tüm rollerini al
	// 2. Base permissions = tüm rollerin OR'u
	// 3. Admin varsa → PermAll döner (tüm override'ları bypass)
	// 4. Bu kanal için kullanıcının rollerine ait override'ları al
	// 5. Allow ve Deny bit'lerini OR'la
	// 6. effective = (base & ~deny) | allow
	ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error)
}

type channelPermService struct {
	permRepo repository.ChannelPermissionRepository
	roleRepo repository.RoleRepository
	hub      ws.EventPublisher
}

// NewChannelPermissionService, ChannelPermissionService implementasyonunu oluşturur.
//
// Dependency'ler:
// - permRepo: kanal permission override CRUD
// - roleRepo: kullanıcının rollerini almak için (ResolveChannelPermissions'da)
// - hub: override değişikliklerini WS ile broadcast etmek için
func NewChannelPermissionService(
	permRepo repository.ChannelPermissionRepository,
	roleRepo repository.RoleRepository,
	hub ws.EventPublisher,
) ChannelPermissionService {
	return &channelPermService{
		permRepo: permRepo,
		roleRepo: roleRepo,
		hub:      hub,
	}
}

func (s *channelPermService) GetOverrides(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	overrides, err := s.permRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel overrides: %w", err)
	}

	// nil yerine boş slice dön — JSON'da [] olarak serialize olur, null değil
	if overrides == nil {
		overrides = []models.ChannelPermissionOverride{}
	}

	return overrides, nil
}

func (s *channelPermService) SetOverride(ctx context.Context, channelID, roleID string, req *models.SetOverrideRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid override request: %w", err)
	}

	// allow=0, deny=0 → override'ın anlamı yok (inherit ile aynı), sil
	if req.Allow == 0 && req.Deny == 0 {
		// Override yoksa hata dönecek ama bunu yutuyoruz — idempotent olsun
		_ = s.permRepo.Delete(ctx, channelID, roleID)

		s.hub.BroadcastToAll(ws.Event{
			Op: ws.OpChannelPermissionDelete,
			Data: map[string]string{
				"channel_id": channelID,
				"role_id":    roleID,
			},
		})

		return nil
	}

	override := &models.ChannelPermissionOverride{
		ChannelID: channelID,
		RoleID:    roleID,
		Allow:     req.Allow,
		Deny:      req.Deny,
	}

	if err := s.permRepo.Set(ctx, override); err != nil {
		return fmt.Errorf("failed to set channel override: %w", err)
	}

	// WS broadcast — tüm client'lar override değişikliğini görsün
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelPermissionUpdate,
		Data: override,
	})

	return nil
}

func (s *channelPermService) DeleteOverride(ctx context.Context, channelID, roleID string) error {
	if err := s.permRepo.Delete(ctx, channelID, roleID); err != nil {
		return fmt.Errorf("failed to delete channel override: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpChannelPermissionDelete,
		Data: map[string]string{
			"channel_id": channelID,
			"role_id":    roleID,
		},
	})

	return nil
}

func (s *channelPermService) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	// 1. Kullanıcının tüm rollerini al
	roles, err := s.roleRepo.GetByUserID(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("failed to get user roles: %w", err)
	}

	// 2. Base permissions = tüm rollerin OR'u
	var base models.Permission
	roleIDs := make([]string, len(roles))
	for i, role := range roles {
		base |= role.Permissions
		roleIDs[i] = role.ID
	}

	// 3. Admin → tüm yetkiler, override'ları bypass
	if base.Has(models.PermAdmin) {
		return models.PermAll, nil
	}

	// 4. Bu kanal için kullanıcının rollerine ait override'ları al
	overrides, err := s.permRepo.GetByChannelAndRoles(ctx, channelID, roleIDs)
	if err != nil {
		return 0, fmt.Errorf("failed to get channel overrides for roles: %w", err)
	}

	// Override yoksa base döner
	if len(overrides) == 0 {
		return base, nil
	}

	// 5. Tüm override'ların allow ve deny bit'lerini OR'la
	//
	// Neden OR? Bir kullanıcı birden fazla role sahip olabilir.
	// Eğer Rol-A allow=SendMessages ve Rol-B deny=SendMessages ise,
	// Discord kuralı: allow, deny'ı override eder (allow öncelikli).
	// Bu, (base & ~deny) | allow formülünde otomatik sağlanır:
	// allow'daki bit, deny'daki aynı bit'i ezer.
	var channelAllow, channelDeny models.Permission
	for _, o := range overrides {
		channelAllow |= o.Allow
		channelDeny |= o.Deny
	}

	// 6. Discord formülü: effective = (base & ~deny) | allow
	//
	// Adım adım:
	// - base & ~deny  → deny'daki bit'leri base'den kaldır
	// - | allow       → allow'daki bit'leri ekle (deny'ı ezer)
	effective := (base & ^channelDeny) | channelAllow

	return effective, nil
}
