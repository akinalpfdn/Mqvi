package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// CategoryRepository defines data access for categories. All list operations are server-scoped.
type CategoryRepository interface {
	Create(ctx context.Context, category *models.Category) error
	GetByID(ctx context.Context, id string) (*models.Category, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Category, error)
	Update(ctx context.Context, category *models.Category) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context, serverID string) (int, error)
}
