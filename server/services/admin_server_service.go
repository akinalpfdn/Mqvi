// Package services — AdminServerService, platform admin sunucu yönetimi.
//
// Platform admin'in herhangi bir sunucuyu silmesini sağlar.
// Owner-only silmeden (ServerService.DeleteServer) farklıdır —
// burada platform admin yetkisi yeterlidir, sahiplik gerekmez.
//
// Silme sırası:
// 1. LiveKit instance cleanup (platform → decrement, self-hosted → delete)
// 2. server_delete broadcast (DB'den ÖNCE — sonra member listesi kaybolur)
// 3. DB delete (CASCADE ile channels, messages, members vs.)
// 4. Opsiyonel email bildirimi (reason + owner email varsa)
package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// AdminServerService, platform admin sunucu silme interface'i.
//
// DeleteServer: Herhangi bir sunucuyu kalıcı olarak siler.
// Tüm channels, messages, members, roles, categories CASCADE ile silinir.
// Reason doldurulmuşsa ve sunucu sahibinin email'i varsa bildirim gönderilir.
type AdminServerService interface {
	DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error
}

type adminServerService struct {
	serverRepo  repository.ServerRepository
	userRepo    repository.UserRepository     // Sunucu sahibinin email'ini almak için
	livekitRepo repository.LiveKitRepository  // LiveKit instance cleanup
	hub         ws.EventPublisher             // server_delete broadcast + BroadcastToServer
	emailSender email.EmailSender             // Opsiyonel — nil ise email gönderilmez
}

// NewAdminServerService, AdminServerService implementasyonunu oluşturur.
//
// Dependency'ler:
//   - serverRepo: Sunucu CRUD (GetByID + Delete)
//   - userRepo: Sunucu sahibinin email adresini almak için
//   - livekitRepo: LiveKit instance cleanup (platform → decrement, self-hosted → delete)
//   - hub: server_delete event broadcast + BroadcastToServer
//   - emailSender: Opsiyonel — reason doldurulursa sunucu sahibine email göndermek için (nil olabilir)
func NewAdminServerService(
	serverRepo repository.ServerRepository,
	userRepo repository.UserRepository,
	livekitRepo repository.LiveKitRepository,
	hub ws.EventPublisher,
	emailSender email.EmailSender,
) AdminServerService {
	return &adminServerService{
		serverRepo:  serverRepo,
		userRepo:    userRepo,
		livekitRepo: livekitRepo,
		hub:         hub,
		emailSender: emailSender,
	}
}

// DeleteServer, sunucuyu kalıcı olarak siler (platform admin yetkisi).
//
// İşlem sırası (ServerService.DeleteServer pattern'ini takip eder):
// 1. Sunucu varlık kontrolü
// 2. LiveKit cleanup — platform-managed ise decrement, self-hosted ise instance sil
// 3. Tüm üyelere server_delete broadcast (DB silmeden ÖNCE — sonra member listesi kaybolur)
// 4. DB'den kalıcı silme (CASCADE ile tüm bağlı veriler silinir)
// 5. Sunucu sahibinin email'ini al, reason + email varsa bildirim gönder
// 6. Log
func (s *adminServerService) DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	// Sunucu varlık kontrolü
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	// LiveKit instance cleanup (ServerService.DeleteServer pattern'i)
	if server.LiveKitInstanceID != nil {
		instance, lkErr := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if lkErr == nil {
			if instance.IsPlatformManaged {
				if decErr := s.livekitRepo.DecrementServerCount(ctx, instance.ID); decErr != nil {
					log.Printf("[admin-server] failed to decrement livekit server count instance=%s: %v", instance.ID, decErr)
				}
			} else {
				if delErr := s.livekitRepo.Delete(ctx, instance.ID); delErr != nil {
					log.Printf("[admin-server] failed to delete self-hosted livekit instance=%s: %v", instance.ID, delErr)
				}
			}
		}
	}

	// Tüm üyelere server_delete broadcast — ÖNCE gönder, sonra sil
	// (sildikten sonra server_members kaybolur, BroadcastToServer çalışmaz)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// DB'den kalıcı silme
	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Email bildirimi — reason doluysa ve sunucu sahibinin email'i varsa gönder
	// Best-effort: hata olursa log et, silme işlemini geri alma
	if reason != "" && s.emailSender != nil {
		owner, ownerErr := s.userRepo.GetByID(ctx, server.OwnerID)
		if ownerErr == nil && owner.Email != nil {
			if emailErr := s.emailSender.SendServerDeleteNotification(ctx, *owner.Email, server.Name, reason); emailErr != nil {
				log.Printf("[admin-server] failed to send server delete notification to owner %s: %v", server.OwnerID, emailErr)
			}
		}
	}

	log.Printf("[admin-server] admin %s deleted server %s (%s)", adminUserID, serverID, server.Name)
	return nil
}
