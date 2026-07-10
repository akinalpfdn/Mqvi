// Package services — AdminServerService: platform admin server management.
//
// Allows platform admin to delete any server (unlike owner-only ServerService.DeleteServer).
//
// Deletion order:
// 1. Collect file refs (read-only)
// 2. server_delete broadcast (BEFORE DB delete — member list is needed for broadcast)
// 3. DB delete (CASCADE removes channels, messages, members, etc.)
// 4. Side effects: file cleanup, LiveKit cleanup, email notification
package services

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// AdminServerService handles platform admin server deletion.
type AdminServerService interface {
	// DeleteServer soft-deletes the server. Owner cannot restore admin-deleted servers
	// (deleted_by_admin=1). Use HardDeleteServer for direct permanent deletion.
	DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error
	// HardDeleteServer permanently deletes the server (skip 30-day TTL).
	// Works on both active and soft-deleted servers.
	HardDeleteServer(ctx context.Context, adminUserID, serverID, reason string) error
	// RestoreServer un-soft-deletes a server (admin override). Works regardless
	// of who soft-deleted it.
	RestoreServer(ctx context.Context, adminUserID, serverID string) error
	// ExpireSoftDeletedServer hard-deletes a server whose 30-day soft-delete
	// window has elapsed. Called only by the embedded cleanup worker — no admin
	// actor, no email notification (owner already knows). Defensive TTL check.
	ExpireSoftDeletedServer(ctx context.Context, serverID string) error
	// SetDiscoveryFlag flips a single admin discovery flag (verified/featured/discovery_blocked)
	// and broadcasts the updated server so members reflect it live. Returns the updated server.
	SetDiscoveryFlag(ctx context.Context, serverID, flag string, value bool) (*models.Server, error)
}

type adminServerService struct {
	serverRepo  repository.ServerRepository
	userRepo    repository.UserRepository
	livekitRepo repository.LiveKitRepository
	hub         ws.EventPublisher
	voiceDisc   VoiceServerDisconnector
	emailSender email.EmailSender // optional, nil = no emails
	fileCleanup FileCleanupService
	urlSigner   FileURLSigner
}

func NewAdminServerService(
	serverRepo repository.ServerRepository,
	userRepo repository.UserRepository,
	livekitRepo repository.LiveKitRepository,
	hub ws.EventPublisher,
	voiceDisc VoiceServerDisconnector,
	emailSender email.EmailSender,
	fileCleanup FileCleanupService,
	urlSigner FileURLSigner,
) AdminServerService {
	return &adminServerService{
		serverRepo:  serverRepo,
		userRepo:    userRepo,
		livekitRepo: livekitRepo,
		hub:         hub,
		voiceDisc:   voiceDisc,
		emailSender: emailSender,
		fileCleanup: fileCleanup,
		urlSigner:   urlSigner,
	}
}

// SetDiscoveryFlag sets verified/featured/discovery_blocked and broadcasts the change.
func (s *adminServerService) SetDiscoveryFlag(ctx context.Context, serverID, flag string, value bool) (*models.Server, error) {
	if err := s.serverRepo.SetDiscoveryFlag(ctx, serverID, flag, value); err != nil {
		return nil, err
	}
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}
	server.IconURL = s.urlSigner.SignURLPtr(server.IconURL)
	server.BannerURL = s.urlSigner.SignURLPtr(server.BannerURL)
	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpServerUpdate, Data: server})
	return server, nil
}

// DeleteServer soft-deletes the server with deleted_by_admin=1.
// Owner cannot restore admin-deleted servers — only an admin can.
func (s *adminServerService) DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	server, err := s.serverRepo.GetActiveByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	if err := s.serverRepo.SoftDelete(ctx, serverID, adminUserID, true); err != nil {
		return fmt.Errorf("failed to soft delete server: %w", err)
	}

	// Members hide the server in their UI on this event.
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Tear down voice participants server-side (same S2 fix as owner delete).
	disconnectServerVoiceParticipants(s.voiceDisc, serverID)

	// Best-effort email to server owner
	if reason != "" && s.emailSender != nil {
		owner, ownerErr := s.userRepo.GetByID(ctx, server.OwnerID)
		if ownerErr == nil && owner.Email != nil {
			if emailErr := s.emailSender.SendServerDeleteNotification(ctx, *owner.Email, server.Name, reason); emailErr != nil {
				log.Printf("[admin-server] failed to send server delete notification to owner %s: %v", server.OwnerID, emailErr)
			}
		}
	}

	log.Printf("[admin-server] admin %s soft-deleted server %s (%s)", adminUserID, serverID, server.Name)
	return nil
}

// HardDeleteServer permanently deletes the server. Works on both active and soft-deleted.
// If active, broadcasts server_delete first so members hide it. If already soft-deleted,
// the broadcast already happened on the original soft-delete.
func (s *adminServerService) HardDeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	wasActive := server.DeletedAt == nil

	plan, collectErr := s.fileCleanup.CollectServerFiles(ctx, serverID)
	if collectErr != nil {
		return fmt.Errorf("failed to collect server files: %w", collectErr)
	}

	if wasActive {
		// Broadcast BEFORE delete (member list is lost after).
		s.hub.BroadcastToServer(serverID, ws.Event{
			Op:   ws.OpServerDelete,
			Data: map[string]string{"id": serverID},
		})
	}

	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Tear down voice participants server-side (no-op if already torn down at soft-delete).
	disconnectServerVoiceParticipants(s.voiceDisc, serverID)

	s.fileCleanup.Execute(plan)

	if reason != "" && s.emailSender != nil {
		owner, ownerErr := s.userRepo.GetByID(ctx, server.OwnerID)
		if ownerErr == nil && owner.Email != nil {
			if emailErr := s.emailSender.SendServerDeleteNotification(ctx, *owner.Email, server.Name, reason); emailErr != nil {
				log.Printf("[admin-server] failed to send server delete notification to owner %s: %v", server.OwnerID, emailErr)
			}
		}
	}

	log.Printf("[admin-server] admin %s hard-deleted server %s (%s)", adminUserID, serverID, server.Name)
	return nil
}

// ExpireSoftDeletedServer is the worker-driven path. The server has already been
// soft-deleted (so members got their server_delete broadcast) — we only need to
// run file cleanup and remove the DB row. Defensive TTL check guards against a
// stale ID (admin restore racing the worker).
func (s *adminServerService) ExpireSoftDeletedServer(ctx context.Context, serverID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("expire target server: %w", err)
	}
	if server.DeletedAt == nil {
		return fmt.Errorf("%w: server is not soft-deleted", pkg.ErrBadRequest)
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -models.SoftDeleteTTLDays)
	if server.DeletedAt.After(cutoff) {
		return fmt.Errorf("%w: soft-delete TTL not yet elapsed (deleted_at=%s)", pkg.ErrBadRequest, server.DeletedAt.Format(time.RFC3339))
	}

	plan, collectErr := s.fileCleanup.CollectServerFiles(ctx, serverID)
	if collectErr != nil {
		return fmt.Errorf("collect server files: %w", collectErr)
	}

	if err := s.serverRepo.Delete(ctx, serverID); err != nil {
		return fmt.Errorf("delete server: %w", err)
	}

	// Defensive: the server was soft-deleted ≥30 days ago (voice already torn down),
	// but disconnect again so no path can leave ghost voice state.
	disconnectServerVoiceParticipants(s.voiceDisc, serverID)

	s.fileCleanup.Execute(plan)
	return nil
}

// RestoreServer un-soft-deletes a server (admin override). Works regardless of who soft-deleted it.
func (s *adminServerService) RestoreServer(ctx context.Context, adminUserID, serverID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	if server.DeletedAt == nil {
		return fmt.Errorf("%w: server is not deleted", pkg.ErrBadRequest)
	}

	if err := s.serverRepo.Restore(ctx, serverID); err != nil {
		return fmt.Errorf("failed to restore server: %w", err)
	}

	// Same approach as serverService.RestoreServer: members who reconnected
	// during the soft-delete window aren't in serverClients[serverID]; we must
	// re-subscribe and BroadcastToUser to reach them.
	restored, restErr := s.serverRepo.GetActiveByID(ctx, serverID)
	if restErr == nil && restored != nil {
		memberIDs, memErr := s.serverRepo.GetMemberUserIDs(ctx, serverID)
		if memErr != nil {
			log.Printf("[admin-server] failed to list members for restore broadcast %s: %v", serverID, memErr)
		} else {
			event := ws.Event{Op: ws.OpServerRestore, Data: restored}
			for _, uid := range memberIDs {
				s.hub.AddClientServerID(uid, serverID)
				s.hub.BroadcastToUser(uid, event)
			}
		}
	}

	log.Printf("[admin-server] admin %s restored server %s (%s)", adminUserID, serverID, server.Name)
	return nil
}
