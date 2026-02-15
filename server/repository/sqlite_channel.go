package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteChannelRepo, ChannelRepository interface'inin SQLite implementasyonu.
type sqliteChannelRepo struct {
	db *sql.DB
}

// NewSQLiteChannelRepo, constructor — interface döner (Dependency Inversion).
func NewSQLiteChannelRepo(db *sql.DB) ChannelRepository {
	return &sqliteChannelRepo{db: db}
}

func (r *sqliteChannelRepo) Create(ctx context.Context, channel *models.Channel) error {
	query := `
		INSERT INTO channels (id, name, type, category_id, topic, position, user_limit, bitrate)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		channel.Name,
		channel.Type,
		channel.CategoryID,
		channel.Topic,
		channel.Position,
		channel.UserLimit,
		channel.Bitrate,
	).Scan(&channel.ID, &channel.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create channel: %w", err)
	}

	return nil
}

func (r *sqliteChannelRepo) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	query := `
		SELECT id, name, type, category_id, topic, position, user_limit, bitrate, created_at
		FROM channels WHERE id = ?`

	ch := &models.Channel{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&ch.ID, &ch.Name, &ch.Type, &ch.CategoryID, &ch.Topic,
		&ch.Position, &ch.UserLimit, &ch.Bitrate, &ch.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get channel by id: %w", err)
	}

	return ch, nil
}

func (r *sqliteChannelRepo) GetAll(ctx context.Context) ([]models.Channel, error) {
	query := `
		SELECT id, name, type, category_id, topic, position, user_limit, bitrate, created_at
		FROM channels ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all channels: %w", err)
	}
	defer rows.Close()

	var channels []models.Channel
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(
			&ch.ID, &ch.Name, &ch.Type, &ch.CategoryID, &ch.Topic,
			&ch.Position, &ch.UserLimit, &ch.Bitrate, &ch.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan channel row: %w", err)
		}
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel rows: %w", err)
	}

	return channels, nil
}

func (r *sqliteChannelRepo) GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error) {
	query := `
		SELECT id, name, type, category_id, topic, position, user_limit, bitrate, created_at
		FROM channels WHERE category_id = ? ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query, categoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels by category: %w", err)
	}
	defer rows.Close()

	var channels []models.Channel
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(
			&ch.ID, &ch.Name, &ch.Type, &ch.CategoryID, &ch.Topic,
			&ch.Position, &ch.UserLimit, &ch.Bitrate, &ch.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan channel row: %w", err)
		}
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel rows: %w", err)
	}

	return channels, nil
}

func (r *sqliteChannelRepo) Update(ctx context.Context, channel *models.Channel) error {
	query := `
		UPDATE channels SET name = ?, topic = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, channel.Name, channel.Topic, channel.ID)
	if err != nil {
		return fmt.Errorf("failed to update channel: %w", err)
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

func (r *sqliteChannelRepo) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete channel: %w", err)
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

// UpdatePositions, birden fazla kanalın position değerini atomik olarak günceller.
// Transaction kullanılır — bir hata olursa tüm değişiklikler geri alınır.
// Bu sayede kısmi güncelleme (partial update) riski ortadan kalkar.
func (r *sqliteChannelRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `UPDATE channels SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		result, err := stmt.ExecContext(ctx, item.Position, item.ID)
		if err != nil {
			return fmt.Errorf("failed to update position for channel %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for channel %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: channel %s", pkg.ErrNotFound, item.ID)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// GetMaxPosition, belirli bir kategorideki en yüksek position değerini döner.
// Yeni kanal eklenirken position = max + 1 olarak atanır.
func (r *sqliteChannelRepo) GetMaxPosition(ctx context.Context, categoryID string) (int, error) {
	query := `SELECT COALESCE(MAX(position), -1) FROM channels WHERE category_id = ?`

	var maxPos int
	err := r.db.QueryRowContext(ctx, query, categoryID).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max channel position: %w", err)
	}

	return maxPos, nil
}
