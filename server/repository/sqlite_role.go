package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteRoleRepo struct {
	db *sql.DB
}

func NewSQLiteRoleRepo(db *sql.DB) RoleRepository {
	return &sqliteRoleRepo{db: db}
}

func (r *sqliteRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	query := `SELECT id, name, color, position, permissions, is_default, created_at FROM roles WHERE id = ?`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&role.ID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get role by id: %w", err)
	}

	return role, nil
}

func (r *sqliteRoleRepo) GetAll(ctx context.Context) ([]models.Role, error) {
	query := `SELECT id, name, color, position, permissions, is_default, created_at FROM roles ORDER BY position DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all roles: %w", err)
	}
	defer rows.Close()

	var roles []models.Role
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(
			&role.ID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan role row: %w", err)
		}
		roles = append(roles, role)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating role rows: %w", err)
	}

	return roles, nil
}

func (r *sqliteRoleRepo) GetDefault(ctx context.Context) (*models.Role, error) {
	query := `SELECT id, name, color, position, permissions, is_default, created_at FROM roles WHERE is_default = 1 LIMIT 1`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query).Scan(
		&role.ID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get default role: %w", err)
	}

	return role, nil
}

func (r *sqliteRoleRepo) GetByUserID(ctx context.Context, userID string) ([]models.Role, error) {
	query := `
		SELECT r.id, r.name, r.color, r.position, r.permissions, r.is_default, r.created_at
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.user_id = ?
		ORDER BY r.position DESC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by user id: %w", err)
	}
	defer rows.Close()

	var roles []models.Role
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(
			&role.ID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan role row: %w", err)
		}
		roles = append(roles, role)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating role rows: %w", err)
	}

	return roles, nil
}

func (r *sqliteRoleRepo) AssignToUser(ctx context.Context, userID string, roleID string) error {
	query := `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`
	_, err := r.db.ExecContext(ctx, query, userID, roleID)
	if err != nil {
		return fmt.Errorf("failed to assign role to user: %w", err)
	}
	return nil
}

func (r *sqliteRoleRepo) RemoveFromUser(ctx context.Context, userID string, roleID string) error {
	_, err := r.db.ExecContext(ctx, query_removeRole, userID, roleID)
	if err != nil {
		return fmt.Errorf("failed to remove role from user: %w", err)
	}
	return nil
}

const query_removeRole = `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`
