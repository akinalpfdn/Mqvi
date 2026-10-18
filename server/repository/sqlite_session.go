package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteSessionRepo struct {
	db database.TxQuerier
}

func NewSQLiteSessionRepo(db database.TxQuerier) SessionRepository {
	return &sqliteSessionRepo{db: db}
}

const sessionColumns = `id, user_id, token_hash, prev_token_hash, pending_token, legacy_token,
	device_id, rotated_at, expires_at, created_at, platform, device_label, ip, city, country`

func scanSession(row interface{ Scan(dest ...any) error }) (*models.Session, error) {
	s := &models.Session{}
	var rotatedAt sql.NullTime
	err := row.Scan(
		&s.ID, &s.UserID, &s.TokenHash, &s.PrevTokenHash, &s.PendingToken, &s.LegacyToken,
		&s.DeviceID, &rotatedAt, &s.ExpiresAt, &s.CreatedAt,
		&s.Client.Platform, &s.Client.DeviceLabel, &s.Client.IP, &s.Client.City, &s.Client.Country,
	)
	if err != nil {
		return nil, err
	}
	if rotatedAt.Valid {
		s.RotatedAt = &rotatedAt.Time
	}
	return s, nil
}

func (r *sqliteSessionRepo) Create(ctx context.Context, session *models.Session) error {
	query := `
		INSERT INTO sessions (id, user_id, token_hash, expires_at, platform, device_label, ip, city, country)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING created_at`

	c := session.Client
	err := r.db.QueryRowContext(ctx, query,
		session.ID,
		session.UserID,
		session.TokenHash,
		session.ExpiresAt.UTC(),
		c.Platform, c.DeviceLabel, c.IP, c.City, c.Country,
	).Scan(&session.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}

	return nil
}

func (r *sqliteSessionRepo) GetByID(ctx context.Context, id string) (*models.Session, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+sessionColumns+` FROM sessions WHERE id = ?`, id)
	s, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}
	return s, nil
}

func (r *sqliteSessionRepo) GetByLegacyToken(ctx context.Context, rawToken, tokenHash string) (*models.Session, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT `+sessionColumns+` FROM sessions WHERE legacy_token = ? OR prev_token_hash = ? LIMIT 1`,
		rawToken, tokenHash,
	)
	s, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get legacy session: %w", err)
	}
	return s, nil
}

// Rotate also records where the session was last used. A field the client did not report keeps
// its previous value (COALESCE), so an older client cannot blank what a newer one stored.
func (r *sqliteSessionRepo) Rotate(ctx context.Context, current *models.Session, next models.SessionRotation) (bool, error) {
	c := next.Client
	res, err := r.db.ExecContext(ctx, `
		UPDATE sessions
		SET token_hash = ?, prev_token_hash = ?, pending_token = ?, legacy_token = NULL,
		    rotated_at = ?, expires_at = ?,
		    platform = COALESCE(?, platform), device_label = COALESCE(?, device_label),
		    ip = COALESCE(?, ip), city = COALESCE(?, city), country = COALESCE(?, country)
		WHERE id = ? AND token_hash IS ? AND legacy_token IS ?`,
		next.TokenHash, next.PrevTokenHash, next.PendingToken,
		next.RotatedAt.UTC(), next.ExpiresAt.UTC(),
		c.Platform, c.DeviceLabel, c.IP, c.City, c.Country,
		current.ID, current.TokenHash, current.LegacyToken,
	)
	if err != nil {
		return false, fmt.Errorf("failed to rotate session: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to read rotate result: %w", err)
	}
	return n == 1, nil
}

func (r *sqliteSessionRepo) ListByUser(ctx context.Context, userID string) ([]models.Session, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+sessionColumns+` FROM sessions WHERE user_id = ?
		 ORDER BY COALESCE(rotated_at, created_at) DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list sessions: %w", err)
	}
	defer func() { _ = rows.Close() }() // read-only cursor; rows.Err below reports iteration failures

	var sessions []models.Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan session: %w", err)
		}
		sessions = append(sessions, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate sessions: %w", err)
	}
	return sessions, nil
}

func (r *sqliteSessionRepo) DeleteForUser(ctx context.Context, id, userID string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return false, fmt.Errorf("failed to delete session: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to read deleted session count: %w", err)
	}
	return n == 1, nil
}

func (r *sqliteSessionRepo) DeleteOthersForUser(ctx context.Context, userID, keepID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`DELETE FROM sessions WHERE user_id = ? AND id != ? RETURNING id`, userID, keepID)
	if err != nil {
		return nil, fmt.Errorf("failed to delete other sessions: %w", err)
	}
	defer func() { _ = rows.Close() }() // read-only cursor; rows.Err below reports iteration failures

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan deleted session id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate deleted sessions: %w", err)
	}
	return ids, nil
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

// Times are written in UTC by this repo, so the text comparison orders correctly. Pre-098 rows may
// carry a local offset; for those the sweep can run late by that offset, never early.
func (r *sqliteSessionRepo) DeleteExpired(ctx context.Context, now time.Time) (int64, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, now.UTC())
	if err != nil {
		return 0, fmt.Errorf("failed to delete expired sessions: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to read expired session count: %w", err)
	}
	return n, nil
}

func (r *sqliteSessionRepo) ClearPending(ctx context.Context, cutoff time.Time) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE sessions SET pending_token = NULL WHERE pending_token IS NOT NULL AND rotated_at < ?`,
		cutoff.UTC(),
	)
	if err != nil {
		return 0, fmt.Errorf("failed to clear pending session tokens: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("failed to read cleared pending count: %w", err)
	}
	return n, nil
}
