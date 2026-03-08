package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ChannelRepository defines data access for channels. All list operations are server-scoped.
type ChannelRepository interface {
	Create(ctx context.Context, channel *models.Channel) error
	GetByID(ctx context.Context, id string) (*models.Channel, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
	GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error)
	Update(ctx context.Context, channel *models.Channel) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context, categoryID string) (int, error)
	// UpdatePositions atomically updates position values for multiple channels.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error
}
