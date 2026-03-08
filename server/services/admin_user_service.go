// Package services — AdminUserService: platform-level user management.
//
// Handles platform-wide ban and hard delete (distinct from server-scoped MemberService.BanUser).
// Email notifications are optional — sent if reason is provided and user has an email.
// Email errors do not roll back the action.
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

// AdminUserService handles platform-level user ban and deletion.
type AdminUserService interface {
	PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error
	PlatformUnbanUser(ctx context.Context, adminUserID, targetUserID string) error
	HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error
	SetPlatformAdmin(ctx context.Context, adminUserID, targetUserID string, isAdmin bool) error
}

type adminUserService struct {
	userRepo    repository.UserRepository
	hub         ws.ClientManager
	voiceKit    VoiceDisconnecter // ISP defined in member_service.go
	emailSender email.EmailSender // optional, nil = no emails
}

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

func (s *adminUserService) PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot ban a platform admin", pkg.ErrForbidden)
	}

	if target.IsPlatformBanned {
		return fmt.Errorf("%w: user is already banned", pkg.ErrBadRequest)
	}

	if err := s.userRepo.PlatformBan(ctx, targetUserID, reason, adminUserID); err != nil {
		return fmt.Errorf("failed to ban user: %w", err)
	}

	if deleteMessages {
		if err := s.userRepo.DeleteAllMessagesByUser(ctx, targetUserID); err != nil {
			return fmt.Errorf("failed to delete user messages: %w", err)
		}
	}

	s.voiceKit.DisconnectUser(targetUserID)
	s.hub.DisconnectUser(targetUserID)

	// Best-effort email notification
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendPlatformBanNotification(ctx, *target.Email, reason); emailErr != nil {
			log.Printf("[admin] failed to send ban notification email to %s: %v", targetUserID, emailErr)
		}
	}

	return nil
}

func (s *adminUserService) PlatformUnbanUser(ctx context.Context, adminUserID, targetUserID string) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot unban yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if !target.IsPlatformBanned {
		return fmt.Errorf("%w: user is not banned", pkg.ErrBadRequest)
	}

	if err := s.userRepo.PlatformUnban(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to unban user: %w", err)
	}

	return nil
}

// HardDeleteUser permanently deletes a user and all associated data.
// Email notification is sent BEFORE deletion (email address is lost after delete).
func (s *adminUserService) HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot delete yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot delete a platform admin", pkg.ErrForbidden)
	}

	// Send email BEFORE deletion (address is lost after)
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendAccountDeleteNotification(ctx, *target.Email, reason); emailErr != nil {
			log.Printf("[admin] failed to send delete notification email to %s: %v", targetUserID, emailErr)
		}
	}

	// Disconnect realtime connections before DB delete to avoid race conditions
	s.voiceKit.DisconnectUser(targetUserID)
	s.hub.DisconnectUser(targetUserID)

	if err := s.userRepo.HardDeleteUser(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}

	return nil
}

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
