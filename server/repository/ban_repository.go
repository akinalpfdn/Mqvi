package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// BanRepository defines data access for server bans. All operations are server-scoped.
type BanRepository interface {
	Create(ctx context.Context, ban *models.Ban) error
	GetByUserID(ctx context.Context, serverID, userID string) (*models.Ban, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Ban, error)
	Delete(ctx context.Context, serverID, userID string) error
	Exists(ctx context.Context, serverID, userID string) (bool, error)
}
