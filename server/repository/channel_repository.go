package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ChannelRepository, kanal veritabanı işlemleri için interface.
// Her method context.Context alır — HTTP isteği iptal edilirse sorgu da durur.
type ChannelRepository interface {
	Create(ctx context.Context, channel *models.Channel) error
	GetByID(ctx context.Context, id string) (*models.Channel, error)
	GetAll(ctx context.Context) ([]models.Channel, error)
	GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error)
	Update(ctx context.Context, channel *models.Channel) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context, categoryID string) (int, error)
	// UpdatePositions, birden fazla kanalın position değerini atomik olarak günceller.
	// Transaction kullanılır — ya hepsi güncellenir ya hiçbiri.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error
}
