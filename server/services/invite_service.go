package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

type InviteService interface {
	Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error)
	ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)
	// Delete removes an invite scoped to serverID (IDOR guard: codes are globally unique).
	Delete(ctx context.Context, serverID, code string) error
	// Validate checks the code (expiry, max-uses, server-active) WITHOUT consuming a use
	// and returns the invite. Lets the caller run membership checks before spending a use.
	Validate(ctx context.Context, code string) (*models.Invite, error)
	// Consume atomically spends one use (max-uses guarded). ErrConflict (no slot left) is
	// mapped to the same "reached max uses" ErrBadRequest as Validate's pre-check.
	Consume(ctx context.Context, code string) error
	// ReleaseUse gives back one use — compensation when a join fails AFTER Consume
	// succeeded (so a failed add doesn't permanently burn a finite invite). Best-effort.
	ReleaseUse(ctx context.Context, code string) error
	// ValidateAndUse = Validate + Consume in one call.
	ValidateAndUse(ctx context.Context, code string) (*models.Invite, error)
	// GetPreview returns server info for an invite code without requiring auth.
	// Returns preview even for expired/maxed-out invites so the user can see
	// the server name/icon (join attempt will fail with a proper error).
	GetPreview(ctx context.Context, code string) (*models.InvitePreview, error)
}

type inviteService struct {
	inviteRepo repository.InviteRepository
	serverRepo repository.ServerRepository
	urlSigner  FileURLSigner
}

func NewInviteService(
	inviteRepo repository.InviteRepository,
	serverRepo repository.ServerRepository,
	urlSigner FileURLSigner,
) InviteService {
	return &inviteService{
		inviteRepo: inviteRepo,
		serverRepo: serverRepo,
		urlSigner:  urlSigner,
	}
}

func (s *inviteService) Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Generate code: 8 random bytes -> 16 hex chars
	codeBytes := make([]byte, 8)
	if _, err := rand.Read(codeBytes); err != nil {
		return nil, fmt.Errorf("failed to generate invite code: %w", err)
	}
	code := hex.EncodeToString(codeBytes)

	invite := &models.Invite{
		Code:      code,
		ServerID:  serverID,
		CreatedBy: &createdBy,
		MaxUses:   req.MaxUses,
	}

	if req.ExpiresIn > 0 {
		expiresAt := time.Now().Add(time.Duration(req.ExpiresIn) * time.Minute)
		invite.ExpiresAt = &expiresAt
	}

	if err := s.inviteRepo.Create(ctx, invite); err != nil {
		return nil, fmt.Errorf("failed to create invite: %w", err)
	}

	// Re-read from DB to get created_at
	created, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("failed to get created invite: %w", err)
	}

	return created, nil
}

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

func (s *inviteService) Delete(ctx context.Context, serverID, code string) error {
	if err := s.inviteRepo.Delete(ctx, serverID, code); err != nil {
		return fmt.Errorf("failed to delete invite: %w", err)
	}
	return nil
}

func (s *inviteService) Validate(ctx context.Context, code string) (*models.Invite, error) {
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid invite code", pkg.ErrBadRequest)
	}

	if invite.ExpiresAt != nil && time.Now().After(*invite.ExpiresAt) {
		return nil, fmt.Errorf("%w: invite code has expired", pkg.ErrBadRequest)
	}

	if invite.MaxUses > 0 && invite.Uses >= invite.MaxUses {
		return nil, fmt.Errorf("%w: invite code has reached max uses", pkg.ErrBadRequest)
	}

	// Reject invites pointing to soft-deleted servers — must not consume invite use
	// or dirty membership data for a server pending hard-delete.
	if _, err := s.serverRepo.GetActiveByID(ctx, invite.ServerID); err != nil {
		return nil, fmt.Errorf("%w: server is no longer available", pkg.ErrNotFound)
	}

	return invite, nil
}

func (s *inviteService) Consume(ctx context.Context, code string) error {
	if err := s.inviteRepo.IncrementUses(ctx, code); err != nil {
		// The pre-check passed but a concurrent join consumed the last slot: the atomic
		// guard matched 0 rows. Surface the same user-facing message as the pre-check.
		if errors.Is(err, pkg.ErrConflict) {
			return fmt.Errorf("%w: invite code has reached max uses", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to increment invite uses: %w", err)
	}
	return nil
}

func (s *inviteService) ReleaseUse(ctx context.Context, code string) error {
	if err := s.inviteRepo.DecrementUses(ctx, code); err != nil {
		return fmt.Errorf("failed to release invite use: %w", err)
	}
	return nil
}

func (s *inviteService) ValidateAndUse(ctx context.Context, code string) (*models.Invite, error) {
	invite, err := s.Validate(ctx, code)
	if err != nil {
		return nil, err
	}
	if err := s.Consume(ctx, code); err != nil {
		return nil, err
	}
	return invite, nil
}

func (s *inviteService) GetPreview(ctx context.Context, code string) (*models.InvitePreview, error) {
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid invite code", pkg.ErrNotFound)
	}

	server, err := s.serverRepo.GetActiveByID(ctx, invite.ServerID)
	if err != nil {
		return nil, fmt.Errorf("%w: server is no longer available", pkg.ErrNotFound)
	}

	memberCount, err := s.serverRepo.GetMemberCount(ctx, invite.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get member count for invite preview: %w", err)
	}

	return &models.InvitePreview{
		ServerName:    server.Name,
		ServerIconURL: s.urlSigner.SignURLPtr(server.IconURL),
		MemberCount:   memberCount,
	}, nil
}
