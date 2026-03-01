package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteSessionRepo, SessionRepository interface'inin SQLite implementasyonu.
type sqliteSessionRepo struct {
	db database.TxQuerier
}

// NewSQLiteSessionRepo, constructor.
func NewSQLiteSessionRepo(db database.TxQuerier) SessionRepository {
	return &sqliteSessionRepo{db: db}
}

func (r *sqliteSessionRepo) Create(ctx context.Context, session *models.Session) error {
	query := `
		INSERT INTO sessions (id, user_id, refresh_token, expires_at)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		session.UserID,
		session.RefreshToken,
		session.ExpiresAt,
	).Scan(&session.ID, &session.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}

	return nil
}

func (r *sqliteSessionRepo) GetByRefreshToken(ctx context.Context, token string) (*models.Session, error) {
	query := `
		SELECT id, user_id, refresh_token, expires_at, created_at
		FROM sessions WHERE refresh_token = ?`

	session := &models.Session{}
	err := r.db.QueryRowContext(ctx, query, token).Scan(
		&session.ID, &session.UserID, &session.RefreshToken,
		&session.ExpiresAt, &session.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get session by refresh token: %w", err)
	}

	return session, nil
}

func (r *sqliteSessionRepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}
	return nil
}

func (r *sqliteSessionRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user sessions: %w", err)
	}
	return nil
}

func (r *sqliteSessionRepo) DeleteExpired(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP`)
	if err != nil {
		return fmt.Errorf("failed to delete expired sessions: %w", err)
	}
	return nil
}
