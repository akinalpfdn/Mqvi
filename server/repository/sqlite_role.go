package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

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

// roleColumns and scanRoleInto are a pair: the column list and the destinations it scans into.
// Adding a roles column means editing both, and nothing else.
const roleColumns = `id, server_id, name, color, position, permissions, is_default, is_owner, mentionable, created_at`

// The joined reads must qualify the columns — user_roles also has a server_id, so the bare list is
// ambiguous there. Derived from roleColumns rather than written out again, so the two cannot drift.
var roleColumnsQualified = qualifyColumns(roleColumns, "r")

func qualifyColumns(columns, alias string) string {
	parts := strings.Split(columns, ",")
	for i, part := range parts {
		parts[i] = alias + "." + strings.TrimSpace(part)
	}
	return strings.Join(parts, ", ")
}

// leading covers the one query that selects an extra column before the role (the grouped read
// takes user_id first); without it that call site would need its own copy of the destinations.
func scanRoleInto(s scanner, role *models.Role, leading ...any) error {
	dest := make([]any, 0, len(leading)+10)
	dest = append(dest, leading...)
	dest = append(dest,
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.IsOwner, &role.Mentionable, &role.CreatedAt,
	)
	return s.Scan(dest...)
}

func scanRole(s scanner) (*models.Role, error) {
	var role models.Role
	if err := scanRoleInto(s, &role); err != nil {
		return nil, err
	}
	return &role, nil
}

// ─── Read ───

func (r *sqliteRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	query := `SELECT ` + roleColumns + ` FROM roles WHERE id = ?`

	role, err := scanRole(r.db.QueryRowContext(ctx, query, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get role by id: %w", err)
	}

	return role, nil
}

func (r *sqliteRoleRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	query := `SELECT ` + roleColumns + ` FROM roles WHERE server_id = ? ORDER BY position DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by server: %w", err)
	}
	defer rows.Close()

	var roles []models.Role
	for rows.Next() {
		var role models.Role
		if err := scanRoleInto(rows, &role); err != nil {
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
	query := `SELECT ` + roleColumns + ` FROM roles WHERE server_id = ? AND is_default = 1 LIMIT 1`

	role, err := scanRole(r.db.QueryRowContext(ctx, query, serverID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get default role: %w", err)
	}

	return role, nil
}

// GetByServerGroupedByUser loads a whole server's role assignments at once.
//
// Same columns, same ORDER BY position DESC as GetByUserIDAndServer, so each user's slice is
// identical to what the per-user call returns — the roster's effective-permission fold and the
// UI's highest-role colour both depend on that order.
func (r *sqliteRoleRepo) GetByServerGroupedByUser(ctx context.Context, serverID string) (map[string][]models.Role, error) {
	query := `
		SELECT ur.user_id, ` + roleColumnsQualified + `
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id AND r.server_id = ur.server_id
		WHERE ur.server_id = ?
		ORDER BY r.position DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles grouped by user: %w", err)
	}
	defer rows.Close()

	byUser := make(map[string][]models.Role)
	for rows.Next() {
		var userID string
		var role models.Role
		if err := scanRoleInto(rows, &role, &userID); err != nil {
			return nil, fmt.Errorf("failed to scan grouped role row: %w", err)
		}
		byUser[userID] = append(byUser[userID], role)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating grouped role rows: %w", err)
	}

	return byUser, nil
}

func (r *sqliteRoleRepo) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	query := `
		SELECT ` + roleColumnsQualified + `
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id AND r.server_id = ur.server_id
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
		if err := scanRoleInto(rows, &role); err != nil {
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

// ─── Write ───

func (r *sqliteRoleRepo) Create(ctx context.Context, role *models.Role) error {
	query := `
		INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	isDefault := 0
	if role.IsDefault {
		isDefault = 1
	}
	isOwner := 0
	if role.IsOwner {
		isOwner = 1
	}
	mentionable := 0
	if role.Mentionable {
		mentionable = 1
	}

	err := r.db.QueryRowContext(ctx, query,
		role.ServerID, role.Name, role.Color, role.Position, role.Permissions, isDefault, isOwner, mentionable,
	).Scan(&role.ID, &role.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create role: %w", err)
	}

	return nil
}

func (r *sqliteRoleRepo) Update(ctx context.Context, role *models.Role) error {
	query := `UPDATE roles SET name = ?, color = ?, permissions = ?, mentionable = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		role.Name, role.Color, role.Permissions, role.Mentionable, role.ID,
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
	// is_default = 0 guard: default role cannot be deleted
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

// UpdatePositions atomically updates role positions within a transaction.
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
