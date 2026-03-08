package repository

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/database"
)

type sqliteChannelMuteRepo struct {
	db database.TxQuerier
}

func NewSQLiteChannelMuteRepo(db database.TxQuerier) ChannelMuteRepository {
	return &sqliteChannelMuteRepo{db: db}
}

// Upsert creates or updates a channel mute. nil mutedUntil = indefinite.
func (r *sqliteChannelMuteRepo) Upsert(ctx context.Context, userID, channelID, serverID string, mutedUntil *string) error {
	query := `
		INSERT INTO channel_mutes (user_id, channel_id, server_id, muted_until)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, channel_id)
		DO UPDATE SET muted_until = excluded.muted_until,
		              created_at = CURRENT_TIMESTAMP`

	_, err := r.db.ExecContext(ctx, query, userID, channelID, serverID, mutedUntil)
	if err != nil {
		return fmt.Errorf("failed to upsert channel mute: %w", err)
	}
	return nil
}

func (r *sqliteChannelMuteRepo) Delete(ctx context.Context, userID, channelID string) error {
	query := `DELETE FROM channel_mutes WHERE user_id = ? AND channel_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to delete channel mute: %w", err)
	}
	return nil
}

// GetMutedChannelIDs returns active muted channel IDs (lazy expiry via WHERE).
func (r *sqliteChannelMuteRepo) GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error) {
	query := `
		SELECT channel_id FROM channel_mutes
		WHERE user_id = ?
		  AND (muted_until IS NULL OR muted_until > datetime('now'))`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get muted channel ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan muted channel id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
