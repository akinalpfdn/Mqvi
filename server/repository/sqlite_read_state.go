package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteReadStateRepo struct {
	db database.TxQuerier
}

func NewSQLiteReadStateRepo(db database.TxQuerier) ReadStateRepository {
	return &sqliteReadStateRepo{db: db}
}

func (r *sqliteReadStateRepo) Upsert(ctx context.Context, userID, channelID, messageID string) error {
	// Mark-as-read path: reset unread_count to 0 alongside watermark update.
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, messageID)
	if err != nil {
		return fmt.Errorf("failed to upsert read state: %w", err)
	}
	return nil
}

// IncrementUnreadCounts bumps unread_count for every existing channel_reads
// row in this channel except the message author's.
func (r *sqliteReadStateRepo) IncrementUnreadCounts(ctx context.Context, channelID, excludeUserID string) error {
	query := `
		UPDATE channel_reads
		SET unread_count = unread_count + 1
		WHERE channel_id = ? AND user_id != ?`

	_, err := r.db.ExecContext(ctx, query, channelID, excludeUserID)
	if err != nil {
		return fmt.Errorf("failed to increment unread counts: %w", err)
	}
	return nil
}

// DecrementUnreadForDeleted lowers unread_count by 1 on every channel_reads row
// whose owner had the deleted message counted as unread. CASE guard keeps the
// counter from going negative if state is ever out of sync.
func (r *sqliteReadStateRepo) DecrementUnreadForDeleted(ctx context.Context, channelID, authorID string, deletedAt time.Time) error {
	query := `
		UPDATE channel_reads
		SET unread_count = CASE WHEN unread_count > 0 THEN unread_count - 1 ELSE 0 END
		WHERE channel_id = ?
		  AND user_id != ?
		  AND (
		      last_read_message_id IS NULL
		      OR ? > (SELECT created_at FROM messages WHERE id = last_read_message_id)
		  )`

	_, err := r.db.ExecContext(ctx, query, channelID, authorID, deletedAt)
	if err != nil {
		return fmt.Errorf("failed to decrement unread counts on delete: %w", err)
	}
	return nil
}

// GetUnreadCounts returns per-channel unread counts for a user in a server.
// Excludes the user's own messages from the count.
//
// Hybrid query: reads the denormalized `unread_count` column when a
// channel_reads row exists (hot path — a single indexed lookup per channel),
// and falls back to COUNT(*) for channels the user has never opened.
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	query := `
		SELECT id, unread_count FROM (
			SELECT c.id,
			       CASE WHEN cr.user_id IS NOT NULL
			            THEN cr.unread_count
			            ELSE (SELECT COUNT(*) FROM messages m
			                  WHERE m.channel_id = c.id
			                    AND m.user_id != ?)
			       END as unread_count
			FROM channels c
			LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
			WHERE c.type = 'text' AND c.server_id = ?
		) WHERE unread_count > 0`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get unread counts: %w", err)
	}
	defer rows.Close()

	var unreads []models.UnreadInfo
	for rows.Next() {
		var info models.UnreadInfo
		if err := rows.Scan(&info.ChannelID, &info.UnreadCount); err != nil {
			return nil, fmt.Errorf("failed to scan unread info: %w", err)
		}
		unreads = append(unreads, info)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating unread rows: %w", err)
	}

	if unreads == nil {
		unreads = []models.UnreadInfo{}
	}

	return unreads, nil
}

// MarkAllRead marks all text channels in a server as read for the user.
// Channels with no messages are skipped (INNER JOIN). Resets unread_count to 0.
func (r *sqliteReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at, unread_count)
		SELECT ?, c.id, latest.id, CURRENT_TIMESTAMP, 0
		FROM channels c
		INNER JOIN (
			SELECT channel_id, id
			FROM messages m1
			WHERE m1.created_at = (
				SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.channel_id = m1.channel_id
			)
		) latest ON latest.channel_id = c.id
		WHERE c.server_id = ? AND c.type = 'text'
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at,
		              unread_count = 0`

	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to mark all channels as read: %w", err)
	}
	return nil
}
