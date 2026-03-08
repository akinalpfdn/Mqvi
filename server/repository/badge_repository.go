package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// BadgeRepository defines data access for badge templates and user-badge assignments.
type BadgeRepository interface {
	// Badge CRUD
	Create(ctx context.Context, badge *models.Badge) error
	GetByID(ctx context.Context, id string) (*models.Badge, error)
	ListAll(ctx context.Context) ([]models.Badge, error)
	Update(ctx context.Context, badge *models.Badge) error
	Delete(ctx context.Context, id string) error

	// User-badge assignments
	Assign(ctx context.Context, ub *models.UserBadge) error
	Unassign(ctx context.Context, userID, badgeID string) error
	GetUserBadges(ctx context.Context, userID string) ([]models.UserBadge, error)
	GetUserBadgesBatch(ctx context.Context, userIDs []string) (map[string][]models.UserBadge, error)
	CountUserBadges(ctx context.Context, userID string) (int, error)
}
