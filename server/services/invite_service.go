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

type InviteService interface {
	Create(ctx context.Context, serverID, createdBy string, req *models.CreateInviteRequest) (*models.Invite, error)
	ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)
	Delete(ctx context.Context, code string) error
	// ValidateAndUse validates the code, increments usage, and returns the invite.
	// Called by ServerService.JoinServer to resolve server_id from the invite.
	ValidateAndUse(ctx context.Context, code string) (*models.Invite, error)
	IsInviteRequired(ctx context.Context, serverID string) (bool, error)
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
		CreatedBy: createdBy,
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

func (s *inviteService) Delete(ctx context.Context, code string) error {
	if err := s.inviteRepo.Delete(ctx, code); err != nil {
		return fmt.Errorf("failed to delete invite: %w", err)
	}
	return nil
}

func (s *inviteService) ValidateAndUse(ctx context.Context, code string) (*models.Invite, error) {
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

	if err := s.inviteRepo.IncrementUses(ctx, code); err != nil {
		return nil, fmt.Errorf("failed to increment invite uses: %w", err)
	}

	return invite, nil
}

func (s *inviteService) IsInviteRequired(ctx context.Context, serverID string) (bool, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return false, fmt.Errorf("failed to get server: %w", err)
	}
	return server.InviteRequired, nil
}

func (s *inviteService) GetPreview(ctx context.Context, code string) (*models.InvitePreview, error) {
	invite, err := s.inviteRepo.GetByCode(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid invite code", pkg.ErrNotFound)
	}

	server, err := s.serverRepo.GetByID(ctx, invite.ServerID)
	if err != nil {
		return nil, fmt.Errorf("failed to get server for invite preview: %w", err)
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
