package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReadStateRepository defines data access for channel read states.
type ReadStateRepository interface {
	Upsert(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error)
	// MarkAllRead marks all text channels in a server as read (upserts each channel's latest message).
	MarkAllRead(ctx context.Context, userID, serverID string) error
}
