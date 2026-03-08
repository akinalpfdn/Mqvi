package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// MessageRepository defines data access for messages.
// GetByChannelID uses cursor-based pagination (beforeID + limit).
type MessageRepository interface {
	Create(ctx context.Context, message *models.Message) error
	GetByID(ctx context.Context, id string) (*models.Message, error)
	GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	Update(ctx context.Context, message *models.Message) error
	Delete(ctx context.Context, id string) error
}
