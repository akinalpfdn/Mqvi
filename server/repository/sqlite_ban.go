package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteBanRepo struct {
	db *sql.DB
}

// NewSQLiteBanRepo, BanRepository'nin SQLite implementasyonunu oluşturur.
func NewSQLiteBanRepo(db *sql.DB) BanRepository {
	return &sqliteBanRepo{db: db}
}

func (r *sqliteBanRepo) Create(ctx context.Context, ban *models.Ban) error {
	query := `
		INSERT INTO bans (user_id, username, reason, banned_by)
		VALUES (?, ?, ?, ?)
		RETURNING created_at`

	err := r.db.QueryRowContext(ctx, query,
		ban.UserID, ban.Username, ban.Reason, ban.BannedBy,
	).Scan(&ban.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create ban: %w", err)
	}

	return nil
}

func (r *sqliteBanRepo) GetByUserID(ctx context.Context, userID string) (*models.Ban, error) {
	query := `SELECT user_id, username, reason, banned_by, created_at FROM bans WHERE user_id = ?`

	ban := &models.Ban{}
	err := r.db.QueryRowContext(ctx, query, userID).Scan(
		&ban.UserID, &ban.Username, &ban.Reason, &ban.BannedBy, &ban.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get ban by user id: %w", err)
	}

	return ban, nil
}

func (r *sqliteBanRepo) GetAll(ctx context.Context) ([]models.Ban, error) {
	query := `SELECT user_id, username, reason, banned_by, created_at FROM bans ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all bans: %w", err)
	}
	defer rows.Close()

	var bans []models.Ban
	for rows.Next() {
		var ban models.Ban
		if err := rows.Scan(
			&ban.UserID, &ban.Username, &ban.Reason, &ban.BannedBy, &ban.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan ban row: %w", err)
		}
		bans = append(bans, ban)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating ban rows: %w", err)
	}

	return bans, nil
}

func (r *sqliteBanRepo) Delete(ctx context.Context, userID string) error {
	query := `DELETE FROM bans WHERE user_id = ?`

	result, err := r.db.ExecContext(ctx, query, userID)
	if err != nil {
		return fmt.Errorf("failed to delete ban: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteBanRepo) Exists(ctx context.Context, userID string) (bool, error) {
	query := `SELECT 1 FROM bans WHERE user_id = ? LIMIT 1`

	var dummy int
	err := r.db.QueryRowContext(ctx, query, userID).Scan(&dummy)

	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check ban existence: %w", err)
	}

	return true, nil
}
