package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteChannelPermRepo struct {
	db database.TxQuerier
}

func NewSQLiteChannelPermRepo(db database.TxQuerier) ChannelPermissionRepository {
	return &sqliteChannelPermRepo{db: db}
}

func (r *sqliteChannelPermRepo) GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	query := `SELECT channel_id, role_id, allow, deny FROM channel_permissions WHERE channel_id = ?`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel permissions: %w", err)
	}
	defer rows.Close()

	var overrides []models.ChannelPermissionOverride
	for rows.Next() {
		var o models.ChannelPermissionOverride
		if err := rows.Scan(&o.ChannelID, &o.RoleID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("failed to scan channel permission row: %w", err)
		}
		overrides = append(overrides, o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel permission rows: %w", err)
	}

	return overrides, nil
}

func (r *sqliteChannelPermRepo) GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if len(roleIDs) == 0 {
		return nil, nil
	}

	placeholders := make([]string, len(roleIDs))
	args := make([]any, 0, len(roleIDs)+1)
	args = append(args, channelID)
	for i, id := range roleIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	query := fmt.Sprintf(
		`SELECT channel_id, role_id, allow, deny FROM channel_permissions WHERE channel_id = ? AND role_id IN (%s)`,
		strings.Join(placeholders, ","),
	)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel permissions by roles: %w", err)
	}
	defer rows.Close()

	var overrides []models.ChannelPermissionOverride
	for rows.Next() {
		var o models.ChannelPermissionOverride
		if err := rows.Scan(&o.ChannelID, &o.RoleID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("failed to scan channel permission row: %w", err)
		}
		overrides = append(overrides, o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel permission rows: %w", err)
	}

	return overrides, nil
}

// GetByRoles returns all channel overrides for the given roles (used for visibility filtering).
func (r *sqliteChannelPermRepo) GetByRoles(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if len(roleIDs) == 0 {
		return nil, nil
	}

	placeholders := make([]string, len(roleIDs))
	args := make([]any, 0, len(roleIDs))
	for i, id := range roleIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	query := fmt.Sprintf(
		`SELECT channel_id, role_id, allow, deny FROM channel_permissions WHERE role_id IN (%s)`,
		strings.Join(placeholders, ","),
	)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel permissions by roles: %w", err)
	}
	defer rows.Close()

	var overrides []models.ChannelPermissionOverride
	for rows.Next() {
		var o models.ChannelPermissionOverride
		if err := rows.Scan(&o.ChannelID, &o.RoleID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("failed to scan channel permission row: %w", err)
		}
		overrides = append(overrides, o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel permission rows: %w", err)
	}

	return overrides, nil
}

func (r *sqliteChannelPermRepo) Set(ctx context.Context, override *models.ChannelPermissionOverride) error {
	query := `
		INSERT INTO channel_permissions (channel_id, role_id, allow, deny)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (channel_id, role_id) DO UPDATE SET
			allow = excluded.allow,
			deny = excluded.deny`

	_, err := r.db.ExecContext(ctx, query,
		override.ChannelID, override.RoleID, override.Allow, override.Deny,
	)
	if err != nil {
		return fmt.Errorf("failed to set channel permission: %w", err)
	}

	return nil
}

func (r *sqliteChannelPermRepo) Delete(ctx context.Context, channelID, roleID string) error {
	query := `DELETE FROM channel_permissions WHERE channel_id = ? AND role_id = ?`

	result, err := r.db.ExecContext(ctx, query, channelID, roleID)
	if err != nil {
		return fmt.Errorf("failed to delete channel permission: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return fmt.Errorf("channel permission override not found")
	}

	return nil
}

func (r *sqliteChannelPermRepo) DeleteAllByChannel(ctx context.Context, channelID string) error {
	query := `DELETE FROM channel_permissions WHERE channel_id = ?`

	_, err := r.db.ExecContext(ctx, query, channelID)
	if err != nil {
		return fmt.Errorf("failed to delete all channel permissions: %w", err)
	}

	// No affected check — channel may have no overrides, that's fine.
	return nil
}
