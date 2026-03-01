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

type sqliteRoleRepo struct {
	db database.TxQuerier
}

func NewSQLiteRoleRepo(db database.TxQuerier) RoleRepository {
	return &sqliteRoleRepo{db: db}
}

// ─── Read operasyonları ───

func (r *sqliteRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, created_at
		FROM roles WHERE id = ?`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
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

func (r *sqliteRoleRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, created_at
		FROM roles WHERE server_id = ? ORDER BY position DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by server: %w", err)
	}
	defer rows.Close()

	var roles []models.Role
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(
			&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
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

func (r *sqliteRoleRepo) GetDefaultByServer(ctx context.Context, serverID string) (*models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, created_at
		FROM roles WHERE server_id = ? AND is_default = 1 LIMIT 1`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
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

func (r *sqliteRoleRepo) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	query := `
		SELECT r.id, r.server_id, r.name, r.color, r.position, r.permissions, r.is_default, r.created_at
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.user_id = ? AND ur.server_id = ?
		ORDER BY r.position DESC`

	rows, err := r.db.QueryContext(ctx, query, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by user and server: %w", err)
	}
	defer rows.Close()

	var roles []models.Role
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(
			&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
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

func (r *sqliteRoleRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	var maxPos int
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(position), 0) FROM roles WHERE server_id = ?`,
		serverID,
	).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max role position: %w", err)
	}
	return maxPos, nil
}

// ─── Write operasyonları ───

func (r *sqliteRoleRepo) Create(ctx context.Context, role *models.Role) error {
	query := `
		INSERT INTO roles (id, server_id, name, color, position, permissions, is_default)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	isDefault := 0
	if role.IsDefault {
		isDefault = 1
	}

	err := r.db.QueryRowContext(ctx, query,
		role.ServerID, role.Name, role.Color, role.Position, role.Permissions, isDefault,
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

// UpdatePositions, birden fazla rolün position değerini atomik olarak günceller.
// Transaction kullanılır — bir hata olursa tüm değişiklikler geri alınır.
func (r *sqliteRoleRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("UpdatePositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `UPDATE roles SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		result, err := stmt.ExecContext(ctx, item.Position, item.ID)
		if err != nil {
			return fmt.Errorf("failed to update position for role %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for role %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: role %s", pkg.ErrNotFound, item.ID)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// ─── User-Role mapping ───

func (r *sqliteRoleRepo) AssignToUser(ctx context.Context, userID, roleID, serverID string) error {
	query := `INSERT OR IGNORE INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query, userID, roleID, serverID)
	if err != nil {
		return fmt.Errorf("failed to assign role to user: %w", err)
	}
	return nil
}

func (r *sqliteRoleRepo) RemoveFromUser(ctx context.Context, userID, roleID string) error {
	query := `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID, roleID)
	if err != nil {
		return fmt.Errorf("failed to remove role from user: %w", err)
	}
	return nil
}
