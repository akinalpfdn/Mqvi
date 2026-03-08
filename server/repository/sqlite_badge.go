package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteBadgeRepo struct {
	db database.TxQuerier
}

// NewSQLiteBadgeRepo creates a new SQLite-backed BadgeRepository.
func NewSQLiteBadgeRepo(db database.TxQuerier) BadgeRepository {
	return &sqliteBadgeRepo{db: db}
}

func (r *sqliteBadgeRepo) Create(ctx context.Context, badge *models.Badge) error {
	query := `
		INSERT INTO badges (id, name, icon, icon_type, color1, color2, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		badge.ID, badge.Name, badge.Icon, badge.IconType,
		badge.Color1, badge.Color2, badge.CreatedBy, badge.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("create badge: %w", err)
	}
	return nil
}

func (r *sqliteBadgeRepo) GetByID(ctx context.Context, id string) (*models.Badge, error) {
	query := `SELECT id, name, icon, icon_type, color1, color2, created_by, created_at FROM badges WHERE id = ?`

	var b models.Badge
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&b.ID, &b.Name, &b.Icon, &b.IconType,
		&b.Color1, &b.Color2, &b.CreatedBy, &b.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get badge by id: %w", err)
	}
	return &b, nil
}

func (r *sqliteBadgeRepo) ListAll(ctx context.Context) ([]models.Badge, error) {
	query := `SELECT id, name, icon, icon_type, color1, color2, created_by, created_at FROM badges ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("list badges: %w", err)
	}
	defer rows.Close()

	var badges []models.Badge
	for rows.Next() {
		var b models.Badge
		if err := rows.Scan(
			&b.ID, &b.Name, &b.Icon, &b.IconType,
			&b.Color1, &b.Color2, &b.CreatedBy, &b.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan badge: %w", err)
		}
		badges = append(badges, b)
	}
	return badges, rows.Err()
}

func (r *sqliteBadgeRepo) Update(ctx context.Context, badge *models.Badge) error {
	query := `UPDATE badges SET name = ?, icon = ?, icon_type = ?, color1 = ?, color2 = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		badge.Name, badge.Icon, badge.IconType, badge.Color1, badge.Color2, badge.ID,
	)
	if err != nil {
		return fmt.Errorf("update badge: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update badge rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("update badge: %w", sql.ErrNoRows)
	}
	return nil
}

func (r *sqliteBadgeRepo) Delete(ctx context.Context, id string) error {
	// user_badges has ON DELETE CASCADE, so assignments are removed automatically.
	_, err := r.db.ExecContext(ctx, `DELETE FROM badges WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete badge: %w", err)
	}
	return nil
}

func (r *sqliteBadgeRepo) Assign(ctx context.Context, ub *models.UserBadge) error {
	query := `
		INSERT INTO user_badges (id, user_id, badge_id, assigned_by, assigned_at)
		VALUES (?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		ub.ID, ub.UserID, ub.BadgeID, ub.AssignedBy, ub.AssignedAt,
	)
	if err != nil {
		return fmt.Errorf("assign badge: %w", err)
	}
	return nil
}

func (r *sqliteBadgeRepo) Unassign(ctx context.Context, userID, badgeID string) error {
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?`, userID, badgeID,
	)
	if err != nil {
		return fmt.Errorf("unassign badge: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("unassign badge rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("unassign badge: %w", sql.ErrNoRows)
	}
	return nil
}

func (r *sqliteBadgeRepo) GetUserBadges(ctx context.Context, userID string) ([]models.UserBadge, error) {
	query := `
		SELECT ub.id, ub.user_id, ub.badge_id, ub.assigned_by, ub.assigned_at,
		       b.id, b.name, b.icon, b.icon_type, b.color1, b.color2, b.created_by, b.created_at
		FROM user_badges ub
		JOIN badges b ON b.id = ub.badge_id
		WHERE ub.user_id = ?
		ORDER BY ub.assigned_at ASC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("get user badges: %w", err)
	}
	defer rows.Close()

	return scanUserBadges(rows)
}

func (r *sqliteBadgeRepo) GetUserBadgesBatch(ctx context.Context, userIDs []string) (map[string][]models.UserBadge, error) {
	if len(userIDs) == 0 {
		return map[string][]models.UserBadge{}, nil
	}

	placeholders := make([]string, len(userIDs))
	args := make([]any, len(userIDs))
	for i, id := range userIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT ub.id, ub.user_id, ub.badge_id, ub.assigned_by, ub.assigned_at,
		       b.id, b.name, b.icon, b.icon_type, b.color1, b.color2, b.created_by, b.created_at
		FROM user_badges ub
		JOIN badges b ON b.id = ub.badge_id
		WHERE ub.user_id IN (%s)
		ORDER BY ub.assigned_at ASC`, strings.Join(placeholders, ","))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get user badges batch: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.UserBadge)
	for rows.Next() {
		ub, err := scanSingleUserBadge(rows)
		if err != nil {
			return nil, err
		}
		result[ub.UserID] = append(result[ub.UserID], *ub)
	}
	return result, rows.Err()
}

func (r *sqliteBadgeRepo) CountUserBadges(ctx context.Context, userID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_badges WHERE user_id = ?`, userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count user badges: %w", err)
	}
	return count, nil
}

// scanUserBadges scans multiple user badge rows with their joined badge data.
func scanUserBadges(rows *sql.Rows) ([]models.UserBadge, error) {
	var result []models.UserBadge
	for rows.Next() {
		ub, err := scanSingleUserBadge(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *ub)
	}
	return result, rows.Err()
}

// scanner is satisfied by both *sql.Row and *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanSingleUserBadge(s scanner) (*models.UserBadge, error) {
	var ub models.UserBadge
	var b models.Badge
	err := s.Scan(
		&ub.ID, &ub.UserID, &ub.BadgeID, &ub.AssignedBy, &ub.AssignedAt,
		&b.ID, &b.Name, &b.Icon, &b.IconType, &b.Color1, &b.Color2, &b.CreatedBy, &b.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan user badge: %w", err)
	}
	ub.Badge = &b
	return &ub, nil
}
