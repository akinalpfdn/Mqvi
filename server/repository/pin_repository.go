package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// PinRepository defines data access for pinned messages.
type PinRepository interface {
	GetByChannelID(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
	Pin(ctx context.Context, pin *models.PinnedMessage) error
	Unpin(ctx context.Context, messageID string) error
	IsPinned(ctx context.Context, messageID string) (bool, error)
	CountByChannelID(ctx context.Context, channelID string) (int, error)
}
