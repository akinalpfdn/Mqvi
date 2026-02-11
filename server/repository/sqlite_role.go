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

// ─── CRUD operasyonları (Faz 3'te eklendi) ───

func (r *sqliteRoleRepo) Create(ctx context.Context, role *models.Role) error {
	query := `
		INSERT INTO roles (id, name, color, position, permissions, is_default)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, 0)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		role.Name, role.Color, role.Position, role.Permissions,
	).Scan(&role.ID, &role.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create role: %w", err)
	}

	return nil
}

func (r *sqliteRoleRepo) Update(ctx context.Context, role *models.Role) error {
	query := `UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		role.Name, role.Color, role.Permissions, role.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update role: %w", err)
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

func (r *sqliteRoleRepo) Delete(ctx context.Context, id string) error {
	// is_default = 0 koşulu: default rol silinemez (DB seviyesinde koruma).
	query := `DELETE FROM roles WHERE id = ? AND is_default = 0`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
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

func (r *sqliteRoleRepo) GetMaxPosition(ctx context.Context) (int, error) {
	var maxPos int
	err := r.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(position), 0) FROM roles`).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max role position: %w", err)
	}
	return maxPos, nil
}
