package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ChannelRepository, kanal veritabanı işlemleri için interface.
// Tüm list operasyonları server-scoped: serverID parametresi zorunlu.
type ChannelRepository interface {
	Create(ctx context.Context, channel *models.Channel) error
	GetByID(ctx context.Context, id string) (*models.Channel, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error)
	GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error)
	Update(ctx context.Context, channel *models.Channel) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context, categoryID string) (int, error)
	// UpdatePositions, birden fazla kanalın position değerini atomik olarak günceller.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error
}
