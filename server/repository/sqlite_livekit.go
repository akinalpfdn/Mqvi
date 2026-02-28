// Package repository — LiveKitRepository'nin SQLite implementasyonu.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteLiveKitRepo struct {
	db *sql.DB
}

// NewSQLiteLiveKitRepo, constructor — interface döner.
func NewSQLiteLiveKitRepo(db *sql.DB) LiveKitRepository {
	return &sqliteLiveKitRepo{db: db}
}

func (r *sqliteLiveKitRepo) Create(ctx context.Context, instance *models.LiveKitInstance) error {
	query := `
		INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret,
		instance.IsPlatformManaged, instance.ServerCount,
	).Scan(&instance.ID, &instance.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create livekit instance: %w", err)
	}

	return nil
}

func (r *sqliteLiveKitRepo) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed, server_count, created_at
		FROM livekit_instances WHERE id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance: %w", err)
	}

	return inst, nil
}

func (r *sqliteLiveKitRepo) GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	query := `
		SELECT li.id, li.url, li.api_key, li.api_secret, li.is_platform_managed, li.server_count, li.created_at
		FROM livekit_instances li
		INNER JOIN servers s ON s.livekit_instance_id = li.id
		WHERE s.id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance by server: %w", err)
	}

	return inst, nil
}

// GetLeastLoadedPlatformInstance, en az sunucu bağlı platform-managed instance'ı döner.
// server_count ASC sıralı, ilk satır = en az yüklü.
func (r *sqliteLiveKitRepo) GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed, server_count, created_at
		FROM livekit_instances
		WHERE is_platform_managed = 1
		ORDER BY server_count ASC
		LIMIT 1`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get least loaded platform instance: %w", err)
	}

	return inst, nil
}

func (r *sqliteLiveKitRepo) IncrementServerCount(ctx context.Context, instanceID string) error {
	query := `UPDATE livekit_instances SET server_count = server_count + 1 WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, instanceID)
	if err != nil {
		return fmt.Errorf("failed to increment server count: %w", err)
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

func (r *sqliteLiveKitRepo) DecrementServerCount(ctx context.Context, instanceID string) error {
	query := `UPDATE livekit_instances SET server_count = MAX(server_count - 1, 0) WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, instanceID)
	if err != nil {
		return fmt.Errorf("failed to decrement server count: %w", err)
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

func (r *sqliteLiveKitRepo) Update(ctx context.Context, instance *models.LiveKitInstance) error {
	query := `UPDATE livekit_instances SET url = ?, api_key = ?, api_secret = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret, instance.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update livekit instance: %w", err)
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

func (r *sqliteLiveKitRepo) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM livekit_instances WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete livekit instance: %w", err)
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
