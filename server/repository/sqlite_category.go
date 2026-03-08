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

type sqliteCategoryRepo struct {
	db database.TxQuerier
}

func NewSQLiteCategoryRepo(db database.TxQuerier) CategoryRepository {
	return &sqliteCategoryRepo{db: db}
}

func (r *sqliteCategoryRepo) Create(ctx context.Context, category *models.Category) error {
	query := `
		INSERT INTO categories (id, server_id, name, position)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		category.ServerID,
		category.Name,
		category.Position,
	).Scan(&category.ID, &category.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create category: %w", err)
	}

	return nil
}

func (r *sqliteCategoryRepo) GetByID(ctx context.Context, id string) (*models.Category, error) {
	query := `SELECT id, server_id, name, position, created_at FROM categories WHERE id = ?`

	cat := &models.Category{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get category by id: %w", err)
	}

	return cat, nil
}

func (r *sqliteCategoryRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Category, error) {
	query := `
		SELECT id, server_id, name, position, created_at
		FROM categories WHERE server_id = ? ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories by server: %w", err)
	}
	defer rows.Close()

	var categories []models.Category
	for rows.Next() {
		var cat models.Category
		if err := rows.Scan(&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan category row: %w", err)
		}
		categories = append(categories, cat)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating category rows: %w", err)
	}

	return categories, nil
}

func (r *sqliteCategoryRepo) Update(ctx context.Context, category *models.Category) error {
	query := `UPDATE categories SET name = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, category.Name, category.ID)
	if err != nil {
		return fmt.Errorf("failed to update category: %w", err)
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

func (r *sqliteCategoryRepo) Delete(ctx context.Context, id string) error {
	// ON DELETE SET NULL nullifies channel category_id references.
	result, err := r.db.ExecContext(ctx, `DELETE FROM categories WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete category: %w", err)
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

// UpdatePositions atomically updates positions for multiple categories.
func (r *sqliteCategoryRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("UpdatePositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `UPDATE categories SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		result, err := stmt.ExecContext(ctx, item.Position, item.ID)
		if err != nil {
			return fmt.Errorf("failed to update position for category %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for category %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: category %s", pkg.ErrNotFound, item.ID)
		}
	}

	return tx.Commit()
}

func (r *sqliteCategoryRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	var maxPos int
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(position), -1) FROM categories WHERE server_id = ?`,
		serverID,
	).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max category position: %w", err)
	}
	return maxPos, nil
}
