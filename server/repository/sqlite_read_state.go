package repository

import (
	"context"
	"fmt"

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
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
		              last_read_at = excluded.last_read_at`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, messageID)
	if err != nil {
		return fmt.Errorf("failed to upsert read state: %w", err)
	}
	return nil
}

// GetUnreadCounts returns per-channel unread counts for a user in a server.
// Excludes the user's own messages from the count.
func (r *sqliteReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	query := `
		SELECT id, unread_count FROM (
			SELECT c.id,
			       (SELECT COUNT(*) FROM messages m
			        WHERE m.channel_id = c.id
			          AND m.user_id != ?
			          AND (cr.last_read_message_id IS NULL
			               OR m.created_at > (SELECT created_at FROM messages WHERE id = cr.last_read_message_id))
			       ) as unread_count
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
// Channels with no messages are skipped (INNER JOIN).
func (r *sqliteReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, last_read_at)
		SELECT ?, c.id, latest.id, CURRENT_TIMESTAMP
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
		              last_read_at = excluded.last_read_at`

	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to mark all channels as read: %w", err)
	}
	return nil
}
