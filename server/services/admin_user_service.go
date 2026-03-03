// Package services — AdminUserService, platform admin kullanıcı yönetimi.
//
// Platform-level ban ve hard delete işlemlerini yönetir.
// Server-scoped ban'lerden (MemberService.BanUser) farklıdır —
// buradaki işlemler platform genelinde geçerlidir.
//
// Email bildirimleri opsiyoneldir — reason doldurulursa ve kullanıcının
// email adresi varsa bildirim gönderilir. Email hatası aksiyonu geri almaz.
package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// AdminUserService, platform admin kullanıcı yönetimi interface'i.
//
// PlatformBanUser: Kullanıcıyı platform genelinde yasaklar.
// Login, WS connect ve aynı email ile yeni kayıt bloklanır.
// Opsiyonel olarak kullanıcının tüm mesajları silinebilir.
// Reason doldurulmuşsa ve kullanıcının email'i varsa bildirim gönderilir.
//
// HardDeleteUser: Kullanıcıyı ve tüm verilerini kalıcı olarak siler.
// Sahip olunan sunucular da dahil — geri dönüşü yoktur.
// Reason doldurulmuşsa ve kullanıcının email'i varsa bildirim gönderilir.
type AdminUserService interface {
	PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error
	HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error
	SetPlatformAdmin(ctx context.Context, adminUserID, targetUserID string, isAdmin bool) error
}

type adminUserService struct {
	userRepo    repository.UserRepository
	hub         ws.ClientManager  // WS bağlantı yönetimi — DisconnectUser için
	voiceKit    VoiceDisconnecter // Voice disconnect — ISP ile minimal bağımlılık (member_service.go'da tanımlı)
	emailSender email.EmailSender // Opsiyonel — nil ise email gönderilmez
}

// NewAdminUserService, AdminUserService implementasyonunu oluşturur.
//
// Dependency'ler:
//   - userRepo: Kullanıcı CRUD + platform ban + hard delete SQL operasyonları
//   - hub: Banlanan/silinen kullanıcının tüm WS bağlantılarını kapatmak için
//   - voiceKit: Banlanan/silinen kullanıcıyı aktif ses kanalından çıkarmak için
//   - emailSender: Opsiyonel — reason doldurulursa kullanıcıya email bildirimi göndermek için (nil olabilir)
func NewAdminUserService(
	userRepo repository.UserRepository,
	hub ws.ClientManager,
	voiceKit VoiceDisconnecter,
	emailSender email.EmailSender,
) AdminUserService {
	return &adminUserService{
		userRepo:    userRepo,
		hub:         hub,
		voiceKit:    voiceKit,
		emailSender: emailSender,
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
// 8. Reason + email varsa → bildirim email'i gönder (best-effort)
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

	// Email bildirimi — reason doluysa ve kullanıcının email'i varsa gönder
	// Best-effort: hata olursa log et, ban işlemini geri alma
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendPlatformBanNotification(ctx, *target.Email, reason); emailErr != nil {
			log.Printf("[admin] failed to send ban notification email to %s: %v", targetUserID, emailErr)
		}
	}

	return nil
}

// HardDeleteUser, kullanıcıyı ve tüm verilerini kalıcı olarak siler.
//
// İşlem sırası:
// 1. Self-delete koruması
// 2. Hedef kullanıcı varlık kontrolü (email adresi de burada alınır)
// 3. Admin-deletes-admin koruması
// 4. Email bildirimi — reason + email varsa ÖNCE gönder (silindikten sonra email kaybolur)
// 5. Aktif voice bağlantısını kes
// 6. Tüm WS bağlantılarını kapat
// 7. DB'den kalıcı silme (CASCADE ile tüm ilişkili veriler silinir)
//
// CASCADE ile silinen veriler: user_roles, messages, sessions, dm_channels,
// dm_messages, message_mentions, reactions, friendships, server_members,
// channel_reads, password_reset_tokens, server_mutes.
// Manuel silinen: bans, servers (owner_id CASCADE yok).
func (s *adminUserService) HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error {
	// Self-delete koruması
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot delete yourself", pkg.ErrBadRequest)
	}

	// Hedef kullanıcıyı kontrol et — email adresi de burada alınıyor
	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	// Admin koruması
	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot delete a platform admin", pkg.ErrForbidden)
	}

	// Email bildirimi — DB silmeden ÖNCE gönder (silindikten sonra email kaybolur)
	// Best-effort: hata olursa log et, silme işlemini geri alma
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendAccountDeleteNotification(ctx, *target.Email, reason); emailErr != nil {
			log.Printf("[admin] failed to send delete notification email to %s: %v", targetUserID, emailErr)
		}
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

// SetPlatformAdmin, hedef kullanıcının platform admin durumunu günceller.
//
// Güvenlik kontrolleri:
//   - Admin kendini değiştiremez (adminsiz kalma riski)
//   - Hedef kullanıcı mevcut olmalı
func (s *adminUserService) SetPlatformAdmin(ctx context.Context, adminUserID, targetUserID string, isAdmin bool) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot modify your own admin status", pkg.ErrBadRequest)
	}

	if _, err := s.userRepo.GetByID(ctx, targetUserID); err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if err := s.userRepo.SetPlatformAdmin(ctx, targetUserID, isAdmin); err != nil {
		return fmt.Errorf("failed to update admin status: %w", err)
	}

	return nil
}
