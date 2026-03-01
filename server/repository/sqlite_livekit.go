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
	// ID'yi Go tarafında üretiyoruz — RETURNING clause'una bağımlı olmamak için.
	// Bazı SQLite driver'larında (modernc.org/sqlite) RETURNING desteklenmeyebilir
	// veya beklenmedik davranış gösterebilir. ID'yi önceden üretmek daha güvenli.
	var generatedID string
	if err := r.db.QueryRowContext(ctx,
		`SELECT lower(hex(randomblob(8)))`,
	).Scan(&generatedID); err != nil {
		return fmt.Errorf("failed to generate livekit instance id: %w", err)
	}

	query := `
		INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers)
		VALUES (?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		generatedID, instance.URL, instance.APIKey, instance.APISecret,
		instance.IsPlatformManaged, instance.ServerCount, instance.MaxServers,
	)
	if err != nil {
		return fmt.Errorf("failed to create livekit instance: %w", err)
	}

	// created_at DB tarafında DEFAULT CURRENT_TIMESTAMP ile atanıyor,
	// geri okuyarak Go struct'ını güncelliyoruz.
	instance.ID = generatedID
	return r.db.QueryRowContext(ctx,
		`SELECT created_at FROM livekit_instances WHERE id = ?`, generatedID,
	).Scan(&instance.CreatedAt)
}

func (r *sqliteLiveKitRepo) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, created_at
		FROM livekit_instances WHERE id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.CreatedAt,
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
		SELECT li.id, li.url, li.api_key, li.api_secret, li.is_platform_managed, li.server_count, li.max_servers, li.created_at
		FROM livekit_instances li
		INNER JOIN servers s ON s.livekit_instance_id = li.id
		WHERE s.id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance by server: %w", err)
	}

	return inst, nil
}

// GetLeastLoadedPlatformInstance, en az sunucu bağlı ve kapasitesi dolmamış
// platform-managed instance'ı döner.
// max_servers = 0 → sınırsız kapasite (her zaman uygun).
// server_count ASC sıralı, ilk satır = en az yüklü.
func (r *sqliteLiveKitRepo) GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, created_at
		FROM livekit_instances
		WHERE is_platform_managed = 1
		  AND (max_servers = 0 OR server_count < max_servers)
		ORDER BY server_count ASC
		LIMIT 1`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.CreatedAt,
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
	query := `UPDATE livekit_instances SET url = ?, api_key = ?, api_secret = ?, max_servers = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret, instance.MaxServers, instance.ID,
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

// ListPlatformInstances, tüm platform-managed LiveKit instance'larını döner.
// Admin panelde liste görünümü için kullanılır. created_at'e göre sıralanır.
func (r *sqliteLiveKitRepo) ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, created_at
		FROM livekit_instances
		WHERE is_platform_managed = 1
		ORDER BY created_at ASC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list platform livekit instances: %w", err)
	}
	defer rows.Close()

	var instances []models.LiveKitInstance
	for rows.Next() {
		var inst models.LiveKitInstance
		if err := rows.Scan(
			&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
			&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan livekit instance row: %w", err)
		}
		instances = append(instances, inst)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating livekit instance rows: %w", err)
	}

	return instances, nil
}

// MigrateServers, bir instance'daki tüm sunucuları başka bir instance'a taşır.
// Transaction içinde çalışır:
//  1. Taşınacak sunucu sayısını sayar
//  2. servers.livekit_instance_id günceller
//  3. Kaynak instance'ın server_count'unu 0 yapar
//  4. Hedef instance'ın server_count'unu artırır
func (r *sqliteLiveKitRepo) MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// 1. Taşınacak sunucu sayısını say
	var count int64
	err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE livekit_instance_id = ?`, fromInstanceID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count servers to migrate: %w", err)
	}

	if count == 0 {
		return 0, nil
	}

	// 2. Sunucuları hedef instance'a taşı
	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ?`,
		toInstanceID, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to migrate servers: %w", err)
	}

	// 3. Kaynak instance'ın server_count'unu 0 yap
	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = 0 WHERE id = ?`, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to reset source server count: %w", err)
	}

	// 4. Hedef instance'ın server_count'unu artır
	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + ? WHERE id = ?`,
		count, toInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update target server count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("failed to commit migration transaction: %w", err)
	}

	return count, nil
}
