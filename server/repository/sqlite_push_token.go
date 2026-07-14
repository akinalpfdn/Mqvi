package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqlitePushTokenRepo struct {
	db database.TxQuerier
}

func NewSQLitePushTokenRepo(db database.TxQuerier) PushTokenRepository {
	return &sqlitePushTokenRepo{db: db}
}

func (r *sqlitePushTokenRepo) Upsert(ctx context.Context, t *models.PushToken) error {
	query := `
		INSERT INTO push_tokens (user_id, token, platform, token_type, device_label, device_id)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(token)
		DO UPDATE SET
			user_id = excluded.user_id,
			platform = excluded.platform,
			token_type = excluded.token_type,
			device_label = excluded.device_label,
			device_id = excluded.device_id,
			last_seen_at = CURRENT_TIMESTAMP
		RETURNING id, created_at, last_seen_at`

	err := r.db.QueryRowContext(ctx, query,
		t.UserID, t.Token, t.Platform, t.TokenType, t.DeviceLabel, t.DeviceID,
	).Scan(&t.ID, &t.CreatedAt, &t.LastSeenAt)
	if err != nil {
		return fmt.Errorf("failed to upsert push token: %w", err)
	}
	return nil
}

func (r *sqlitePushTokenRepo) ListByUser(ctx context.Context, userID string) ([]models.PushToken, error) {
	query := `
		SELECT id, user_id, token, platform, token_type, device_label, device_id, created_at, last_seen_at
		FROM push_tokens
		WHERE user_id = ?
		ORDER BY last_seen_at DESC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list push tokens: %w", err)
	}
	defer rows.Close()

	var tokens []models.PushToken
	for rows.Next() {
		var t models.PushToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Token, &t.Platform, &t.TokenType, &t.DeviceLabel, &t.DeviceID, &t.CreatedAt, &t.LastSeenAt); err != nil {
			return nil, fmt.Errorf("failed to scan push token: %w", err)
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("push token rows iteration: %w", err)
	}
	return tokens, nil
}

func (r *sqlitePushTokenRepo) Delete(ctx context.Context, userID, token string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM push_tokens WHERE user_id = ? AND token = ?`, userID, token)
	if err != nil {
		return fmt.Errorf("failed to delete push token: %w", err)
	}
	return nil
}

func (r *sqlitePushTokenRepo) DeleteTokens(ctx context.Context, tokens []string) error {
	if len(tokens) == 0 {
		return nil
	}
	placeholders := make([]string, len(tokens))
	args := make([]any, len(tokens))
	for i, tok := range tokens {
		placeholders[i] = "?"
		args[i] = tok
	}
	query := fmt.Sprintf(`DELETE FROM push_tokens WHERE token IN (%s)`, strings.Join(placeholders, ","))
	if _, err := r.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("failed to delete push tokens: %w", err)
	}
	return nil
}
