// Package services — AdminUserService, platform admin kullanıcı yönetimi.
//
// Platform-level ban ve hard delete işlemlerini yönetir.
// Server-scoped ban'lerden (MemberService.BanUser) farklıdır —
// buradaki işlemler platform genelinde geçerlidir.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// AdminUserService, platform admin kullanıcı yönetimi interface'i.
//
// PlatformBanUser: Kullanıcıyı platform genelinde yasaklar.
// Login, WS connect ve aynı email ile yeni kayıt bloklanır.
// Opsiyonel olarak kullanıcının tüm mesajları silinebilir.
//
// HardDeleteUser: Kullanıcıyı ve tüm verilerini kalıcı olarak siler.
// Sahip olunan sunucular da dahil — geri dönüşü yoktur.
type AdminUserService interface {
	PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error
	HardDeleteUser(ctx context.Context, adminUserID, targetUserID string) error
}

type adminUserService struct {
	userRepo repository.UserRepository
	hub      ws.ClientManager    // WS bağlantı yönetimi — DisconnectUser için
	voiceKit VoiceDisconnecter   // Voice disconnect — ISP ile minimal bağımlılık (member_service.go'da tanımlı)
}

// NewAdminUserService, AdminUserService implementasyonunu oluşturur.
//
// Dependency'ler:
//   - userRepo: Kullanıcı CRUD + platform ban + hard delete SQL operasyonları
//   - hub: Banlanan/silinen kullanıcının tüm WS bağlantılarını kapatmak için
//   - voiceKit: Banlanan/silinen kullanıcıyı aktif ses kanalından çıkarmak için
func NewAdminUserService(
	userRepo repository.UserRepository,
	hub ws.ClientManager,
	voiceKit VoiceDisconnecter,
) AdminUserService {
	return &adminUserService{
		userRepo: userRepo,
		hub:      hub,
		voiceKit: voiceKit,
	}
}

// PlatformBanUser, kullanıcıyı platform genelinde yasaklar.
//
// İşlem sırası:
// 1. Self-ban koruması (admin kendini banlayamaz)
// 2. Hedef kullanıcı varlık kontrolü
// 3. Admin-bans-admin koruması (platform admin banlanamaaz)
// 4. DB'de is_platform_banned flag'ini set et
// 5. Opsiyonel: Tüm mesajları sil (server + DM)
// 6. Aktif voice bağlantısını kes
// 7. Tüm WS bağlantılarını kapat → client anında disconnect olur
func (s *adminUserService) PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error {
	// Self-ban koruması
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	// Hedef kullanıcıyı kontrol et
	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	// Admin koruması — platform admin başka bir platform admin'i banlayamaz
	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot ban a platform admin", pkg.ErrForbidden)
	}

	// Zaten banlı mı?
	if target.IsPlatformBanned {
		return fmt.Errorf("%w: user is already banned", pkg.ErrBadRequest)
	}

	// DB'de ban flag'ini set et
	if err := s.userRepo.PlatformBan(ctx, targetUserID, reason, adminUserID); err != nil {
		return fmt.Errorf("failed to ban user: %w", err)
	}

	// Opsiyonel mesaj silme
	if deleteMessages {
		if err := s.userRepo.DeleteAllMessagesByUser(ctx, targetUserID); err != nil {
			return fmt.Errorf("failed to delete user messages: %w", err)
		}
	}

	// Aktif voice bağlantısını kes
	s.voiceKit.DisconnectUser(targetUserID)

	// Tüm WS bağlantılarını kapat — client anında disconnect olur
	s.hub.DisconnectUser(targetUserID)

	return nil
}

// HardDeleteUser, kullanıcıyı ve tüm verilerini kalıcı olarak siler.
//
// İşlem sırası:
// 1. Self-delete koruması
// 2. Hedef kullanıcı varlık kontrolü
// 3. Admin-deletes-admin koruması
// 4. Aktif voice bağlantısını kes
// 5. Tüm WS bağlantılarını kapat
// 6. DB'den kalıcı silme (CASCADE ile tüm ilişkili veriler silinir)
//
// CASCADE ile silinen veriler: user_roles, messages, sessions, dm_channels,
// dm_messages, message_mentions, reactions, friendships, server_members,
// channel_reads, password_reset_tokens, server_mutes.
// Manuel silinen: bans, servers (owner_id CASCADE yok).
func (s *adminUserService) HardDeleteUser(ctx context.Context, adminUserID, targetUserID string) error {
	// Self-delete koruması
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot delete yourself", pkg.ErrBadRequest)
	}

	// Hedef kullanıcıyı kontrol et
	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	// Admin koruması
	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot delete a platform admin", pkg.ErrForbidden)
	}

	// Önce realtime bağlantıları kes — DB silindikten sonra voice/ws temizliği
	// yapmaya çalışmak race condition'a yol açabilir
	s.voiceKit.DisconnectUser(targetUserID)
	s.hub.DisconnectUser(targetUserID)

	// DB'den kalıcı silme
	if err := s.userRepo.HardDeleteUser(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}

	return nil
}
