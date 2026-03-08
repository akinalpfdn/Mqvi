// Package services — AdminServerService: platform admin server management.
//
// Allows platform admin to delete any server (unlike owner-only ServerService.DeleteServer).
//
// Deletion order:
// 1. LiveKit instance cleanup (platform -> decrement, self-hosted -> delete)
// 2. server_delete broadcast (BEFORE DB delete — member list is needed for broadcast)
// 3. DB delete (CASCADE removes channels, messages, members, etc.)
// 4. Optional email notification to server owner
package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// AdminServerService handles platform admin server deletion.
type AdminServerService interface {
	DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error
}

type adminServerService struct {
	serverRepo  repository.ServerRepository
	userRepo    repository.UserRepository
	livekitRepo repository.LiveKitRepository
	hub         ws.EventPublisher
	emailSender email.EmailSender // optional, nil = no emails
}

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

func (s *adminServerService) DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	// LiveKit instance cleanup
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

	// Broadcast BEFORE delete (member list is lost after)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Best-effort email to server owner
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
