package repository

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteGroupSessionRepo struct {
	db database.TxQuerier
}

func NewSQLiteGroupSessionRepo(db database.TxQuerier) GroupSessionRepository {
	return &sqliteGroupSessionRepo{db: db}
}

func (r *sqliteGroupSessionRepo) Upsert(ctx context.Context, channelID, senderUserID, senderDeviceID string, req *models.CreateGroupSessionRequest) error {
	query := `
		INSERT INTO channel_group_sessions (channel_id, sender_user_id, sender_device_id, session_id, session_data)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(channel_id, sender_user_id, sender_device_id, session_id)
		DO UPDATE SET
			session_data = excluded.session_data,
			created_at = CURRENT_TIMESTAMP`

	_, err := r.db.ExecContext(ctx, query,
		channelID, senderUserID, senderDeviceID, req.SessionID, req.SessionData,
	)
	if err != nil {
		return fmt.Errorf("failed to upsert group session: %w", err)
	}
	return nil
}

func (r *sqliteGroupSessionRepo) GetByChannel(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error) {
	query := `
		SELECT id, channel_id, sender_user_id, sender_device_id,
			session_id, session_data, message_index, created_at
		FROM channel_group_sessions
		WHERE channel_id = ?
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get group sessions: %w", err)
	}
	defer rows.Close()

	var sessions []models.ChannelGroupSession
	for rows.Next() {
		var s models.ChannelGroupSession
		if err := rows.Scan(
			&s.ID, &s.ChannelID, &s.SenderUserID, &s.SenderDeviceID,
			&s.SessionID, &s.SessionData, &s.MessageIndex, &s.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan group session: %w", err)
		}
		sessions = append(sessions, s)
	}
	return sessions, rows.Err()
}

// DeleteByChannel removes all group sessions for a channel (used during key rotation).
func (r *sqliteGroupSessionRepo) DeleteByChannel(ctx context.Context, channelID string) error {
	query := `DELETE FROM channel_group_sessions WHERE channel_id = ?`
	_, err := r.db.ExecContext(ctx, query, channelID)
	if err != nil {
		return fmt.Errorf("failed to delete channel group sessions: %w", err)
	}
	return nil
}

// DeleteByUser removes a user's sessions from a channel (kick/ban invalidation).
func (r *sqliteGroupSessionRepo) DeleteByUser(ctx context.Context, channelID, userID string) error {
	query := `DELETE FROM channel_group_sessions WHERE channel_id = ? AND sender_user_id = ?`
	_, err := r.db.ExecContext(ctx, query, channelID, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user group sessions: %w", err)
	}
	return nil
}

var _ GroupSessionRepository = (*sqliteGroupSessionRepo)(nil)
