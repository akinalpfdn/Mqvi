package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteJoinRequestRepo struct {
	db database.TxQuerier
}

func NewSQLiteJoinRequestRepo(db database.TxQuerier) JoinRequestRepository {
	return &sqliteJoinRequestRepo{db: db}
}

func (r *sqliteJoinRequestRepo) Create(ctx context.Context, serverID, userID, inviteCode string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO server_join_requests (server_id, user_id, invite_code) VALUES (?, ?, ?)`,
		serverID, userID, inviteCode,
	)
	if err != nil {
		return fmt.Errorf("failed to create join request: %w", err)
	}
	return nil
}

func (r *sqliteJoinRequestRepo) Delete(ctx context.Context, serverID, userID string) (bool, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM server_join_requests WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	)
	if err != nil {
		return false, fmt.Errorf("failed to delete join request: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (r *sqliteJoinRequestRepo) Exists(ctx context.Context, serverID, userID string) (bool, error) {
	var one int
	err := r.db.QueryRowContext(ctx,
		`SELECT 1 FROM server_join_requests WHERE server_id = ? AND user_id = ? LIMIT 1`,
		serverID, userID,
	).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check join request: %w", err)
	}
	return true, nil
}

func (r *sqliteJoinRequestRepo) CountByServer(ctx context.Context, serverID string) (int, error) {
	var n int
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM server_join_requests WHERE server_id = ?`, serverID,
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count join requests: %w", err)
	}
	return n, nil
}

func (r *sqliteJoinRequestRepo) ListByServer(ctx context.Context, serverID string) ([]models.ServerJoinRequestWithUser, error) {
	query := `
		SELECT jr.server_id, jr.user_id, jr.invite_code, jr.created_at,
			u.username, u.display_name, u.avatar_url
		FROM server_join_requests jr
		JOIN users u ON u.id = jr.user_id
		WHERE jr.server_id = ?
		ORDER BY jr.created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list join requests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerJoinRequestWithUser
	for rows.Next() {
		var req models.ServerJoinRequestWithUser
		var inviteCode, displayName, avatarURL sql.NullString
		if err := rows.Scan(
			&req.ServerID, &req.UserID, &inviteCode, &req.CreatedAt,
			&req.Username, &displayName, &avatarURL,
		); err != nil {
			return nil, fmt.Errorf("failed to scan join request: %w", err)
		}
		if inviteCode.Valid {
			req.InviteCode = &inviteCode.String
		}
		if displayName.Valid {
			req.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			req.AvatarURL = &avatarURL.String
		}
		out = append(out, req)
	}
	return out, rows.Err()
}
