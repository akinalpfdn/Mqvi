package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// BadgeAdminUserID is the only user allowed to manage badges.
const BadgeAdminUserID = "95a8b295072f98a5"

const maxBadgeNameLength = 20

// BadgeService defines business logic for badge management.
type BadgeService interface {
	CreateBadge(ctx context.Context, adminID string, req *models.CreateBadgeRequest) (*models.Badge, error)
	ListBadges(ctx context.Context) ([]models.Badge, error)
	UpdateBadge(ctx context.Context, adminID string, badgeID string, req *models.CreateBadgeRequest) (*models.Badge, error)
	DeleteBadge(ctx context.Context, adminID string, badgeID string) error
	AssignBadge(ctx context.Context, adminID, userID, badgeID string) (*models.UserBadge, error)
	UnassignBadge(ctx context.Context, adminID, userID, badgeID string) error
	GetUserBadges(ctx context.Context, userID string) ([]models.UserBadge, error)
	GetUserBadgesBatch(ctx context.Context, userIDs []string) (map[string][]models.UserBadge, error)
}

type badgeService struct {
	badgeRepo repository.BadgeRepository
	hub       ws.EventPublisher
}

// NewBadgeService creates a new BadgeService.
func NewBadgeService(badgeRepo repository.BadgeRepository, hub ws.EventPublisher) BadgeService {
	return &badgeService{badgeRepo: badgeRepo, hub: hub}
}

func (s *badgeService) requireAdmin(adminID string) error {
	if adminID != BadgeAdminUserID {
		return fmt.Errorf("%w: only badge admin can perform this action", pkg.ErrForbidden)
	}
	return nil
}

func generateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *badgeService) CreateBadge(ctx context.Context, adminID string, req *models.CreateBadgeRequest) (*models.Badge, error) {
	if err := s.requireAdmin(adminID); err != nil {
		return nil, err
	}

	if req.Name == "" {
		return nil, fmt.Errorf("%w: badge name is required", pkg.ErrBadRequest)
	}
	if utf8.RuneCountInString(req.Name) > maxBadgeNameLength {
		return nil, fmt.Errorf("%w: badge name too long (max %d)", pkg.ErrBadRequest, maxBadgeNameLength)
	}
	if req.IconType != "builtin" && req.IconType != "custom" {
		return nil, fmt.Errorf("%w: icon_type must be 'builtin' or 'custom'", pkg.ErrBadRequest)
	}
	if req.Color1 == "" {
		return nil, fmt.Errorf("%w: color1 is required", pkg.ErrBadRequest)
	}

	badge := &models.Badge{
		ID:        generateID(),
		Name:      req.Name,
		Icon:      req.Icon,
		IconType:  req.IconType,
		Color1:    req.Color1,
		Color2:    req.Color2,
		CreatedBy: adminID,
		CreatedAt: time.Now().UTC(),
	}

	if err := s.badgeRepo.Create(ctx, badge); err != nil {
		return nil, fmt.Errorf("create badge: %w", err)
	}

	return badge, nil
}

func (s *badgeService) ListBadges(ctx context.Context) ([]models.Badge, error) {
	return s.badgeRepo.ListAll(ctx)
}

func (s *badgeService) UpdateBadge(ctx context.Context, adminID string, badgeID string, req *models.CreateBadgeRequest) (*models.Badge, error) {
	if err := s.requireAdmin(adminID); err != nil {
		return nil, err
	}

	existing, err := s.badgeRepo.GetByID(ctx, badgeID)
	if err != nil {
		return nil, fmt.Errorf("update badge: %w", err)
	}
	if existing == nil {
		return nil, fmt.Errorf("%w: badge not found", pkg.ErrNotFound)
	}

	if req.Name == "" {
		return nil, fmt.Errorf("%w: badge name is required", pkg.ErrBadRequest)
	}
	if utf8.RuneCountInString(req.Name) > maxBadgeNameLength {
		return nil, fmt.Errorf("%w: badge name too long (max %d)", pkg.ErrBadRequest, maxBadgeNameLength)
	}

	existing.Name = req.Name
	existing.Icon = req.Icon
	existing.IconType = req.IconType
	existing.Color1 = req.Color1
	existing.Color2 = req.Color2

	if err := s.badgeRepo.Update(ctx, existing); err != nil {
		return nil, err
	}

	return existing, nil
}

func (s *badgeService) DeleteBadge(ctx context.Context, adminID string, badgeID string) error {
	if err := s.requireAdmin(adminID); err != nil {
		return err
	}

	existing, err := s.badgeRepo.GetByID(ctx, badgeID)
	if err != nil {
		return fmt.Errorf("delete badge: %w", err)
	}
	if existing == nil {
		return fmt.Errorf("%w: badge not found", pkg.ErrNotFound)
	}

	return s.badgeRepo.Delete(ctx, badgeID)
}

func (s *badgeService) AssignBadge(ctx context.Context, adminID, userID, badgeID string) (*models.UserBadge, error) {
	if err := s.requireAdmin(adminID); err != nil {
		return nil, err
	}

	// Verify badge exists
	badge, err := s.badgeRepo.GetByID(ctx, badgeID)
	if err != nil {
		return nil, fmt.Errorf("assign badge: %w", err)
	}
	if badge == nil {
		return nil, fmt.Errorf("%w: badge not found", pkg.ErrNotFound)
	}

	// Check max badges per user
	count, err := s.badgeRepo.CountUserBadges(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("assign badge count: %w", err)
	}
	if count >= models.MaxBadgesPerUser {
		return nil, fmt.Errorf("%w: user already has maximum number of badges (%d)", pkg.ErrBadRequest, models.MaxBadgesPerUser)
	}

	ub := &models.UserBadge{
		ID:         generateID(),
		UserID:     userID,
		BadgeID:    badgeID,
		AssignedBy: adminID,
		AssignedAt: time.Now().UTC(),
		Badge:      badge,
	}

	if err := s.badgeRepo.Assign(ctx, ub); err != nil {
		return nil, fmt.Errorf("assign badge: %w", err)
	}

	// Broadcast badge assignment
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpBadgeAssign,
		Data: map[string]any{
			"user_id":    userID,
			"user_badge": ub,
		},
	})

	return ub, nil
}

func (s *badgeService) UnassignBadge(ctx context.Context, adminID, userID, badgeID string) error {
	if err := s.requireAdmin(adminID); err != nil {
		return err
	}

	if err := s.badgeRepo.Unassign(ctx, userID, badgeID); err != nil {
		return fmt.Errorf("unassign badge: %w", err)
	}

	// Broadcast badge removal
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpBadgeUnassign,
		Data: map[string]any{
			"user_id":  userID,
			"badge_id": badgeID,
		},
	})

	return nil
}

func (s *badgeService) GetUserBadges(ctx context.Context, userID string) ([]models.UserBadge, error) {
	return s.badgeRepo.GetUserBadges(ctx, userID)
}

func (s *badgeService) GetUserBadgesBatch(ctx context.Context, userIDs []string) (map[string][]models.UserBadge, error) {
	return s.badgeRepo.GetUserBadgesBatch(ctx, userIDs)
}
