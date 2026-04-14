package repository

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
)

// ReadStateRepository defines data access for channel read states.
type ReadStateRepository interface {
	Upsert(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error)
	// MarkAllRead marks all text channels in a server as read (upserts each channel's latest message).
	MarkAllRead(ctx context.Context, userID, serverID string) error
	// IncrementUnreadCounts bumps unread_count for every user with a channel_reads
	// row in the channel, excluding the author. Skipping users without a row is
	// intentional — their count falls back to COUNT(*) until they open the channel.
	IncrementUnreadCounts(ctx context.Context, channelID, excludeUserID string) error
	// DecrementUnreadForDeleted lowers unread_count by 1 for every user who had the
	// deleted message counted as unread (row exists and the message is newer than
	// their watermark). Preserves the pre-denormalization behavior where unread
	// counts reflected the current message set.
	DecrementUnreadForDeleted(ctx context.Context, channelID, authorID string, deletedAt time.Time) error
}
