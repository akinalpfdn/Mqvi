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

type sqliteLiveKitRepo struct {
	db database.TxQuerier
}

func NewSQLiteLiveKitRepo(db database.TxQuerier) LiveKitRepository {
	return &sqliteLiveKitRepo{db: db}
}

func (r *sqliteLiveKitRepo) Create(ctx context.Context, instance *models.LiveKitInstance) error {
	// Generate ID in Go rather than relying on RETURNING for safer cross-driver compat.
	var generatedID string
	if err := r.db.QueryRowContext(ctx,
		`SELECT lower(hex(randomblob(8)))`,
	).Scan(&generatedID); err != nil {
		return fmt.Errorf("failed to generate livekit instance id: %w", err)
	}

	query := `
		INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, hetzner_server_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		generatedID, instance.URL, instance.APIKey, instance.APISecret,
		instance.IsPlatformManaged, instance.ServerCount, instance.MaxServers, instance.HetznerServerID,
	)
	if err != nil {
		return fmt.Errorf("failed to create livekit instance: %w", err)
	}

	// Read back created_at (DB default)
	instance.ID = generatedID
	return r.db.QueryRowContext(ctx,
		`SELECT created_at FROM livekit_instances WHERE id = ?`, generatedID,
	).Scan(&instance.CreatedAt)
}

func (r *sqliteLiveKitRepo) GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error) {
	// Use COUNT(*) instead of stored server_count to avoid drift from increment/decrement bugs.
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed,
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS server_count,
		       max_servers, hetzner_server_id, created_at
		FROM livekit_instances WHERE id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.CreatedAt,
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
		SELECT li.id, li.url, li.api_key, li.api_secret, li.is_platform_managed,
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = li.id) AS server_count,
		       li.max_servers, li.hetzner_server_id, li.created_at
		FROM livekit_instances li
		INNER JOIN servers s ON s.livekit_instance_id = li.id
		WHERE s.id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance by server: %w", err)
	}

	return inst, nil
}

// GetLeastLoadedPlatformInstance returns the platform-managed instance with fewest servers
// that still has capacity. max_servers = 0 means unlimited.
func (r *sqliteLiveKitRepo) GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed,
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS server_count,
		       max_servers, hetzner_server_id, created_at
		FROM livekit_instances
		WHERE is_platform_managed = 1
		  AND (max_servers = 0 OR (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) < max_servers)
		ORDER BY server_count ASC
		LIMIT 1`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.CreatedAt,
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
	query := `UPDATE livekit_instances SET url = ?, api_key = ?, api_secret = ?, max_servers = ?, hetzner_server_id = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret, instance.MaxServers, instance.HetznerServerID, instance.ID,
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

// ListPlatformInstances returns all platform-managed LiveKit instances for admin panel.
func (r *sqliteLiveKitRepo) ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed,
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS server_count,
		       max_servers, hetzner_server_id, created_at
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
			&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.CreatedAt,
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

// ListAllInstances returns all LiveKit instances regardless of platform-managed flag.
// Only id, api_key, api_secret are needed — used by webhook HMAC verification.
func (r *sqliteLiveKitRepo) ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id, api_key, api_secret FROM livekit_instances`)
	if err != nil {
		return nil, fmt.Errorf("list all livekit instances: %w", err)
	}
	defer rows.Close()

	var instances []models.LiveKitInstance
	for rows.Next() {
		var inst models.LiveKitInstance
		if err := rows.Scan(&inst.ID, &inst.APIKey, &inst.APISecret); err != nil {
			return nil, fmt.Errorf("scan livekit instance: %w", err)
		}
		instances = append(instances, inst)
	}
	return instances, nil
}

// MigrateServers moves all servers from one instance to another within a transaction.
func (r *sqliteLiveKitRepo) MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error) {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return 0, fmt.Errorf("MigrateServers requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

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

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ?`,
		toInstanceID, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to migrate servers: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = 0 WHERE id = ?`, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to reset source server count: %w", err)
	}

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

// MigrateOneServer moves a single server to a different LiveKit instance within a transaction.
func (r *sqliteLiveKitRepo) MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("MigrateOneServer requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	var oldInstanceID sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT livekit_instance_id FROM servers WHERE id = ?`, serverID,
	).Scan(&oldInstanceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return pkg.ErrNotFound
		}
		return fmt.Errorf("failed to get server current instance: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE id = ?`,
		newInstanceID, serverID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server instance: %w", err)
	}

	// Decrement old instance count if it changed
	if oldInstanceID.Valid && oldInstanceID.String != "" && oldInstanceID.String != newInstanceID {
		_, err = tx.ExecContext(ctx,
			`UPDATE livekit_instances SET server_count = MAX(server_count - 1, 0) WHERE id = ?`,
			oldInstanceID.String,
		)
		if err != nil {
			return fmt.Errorf("failed to decrement old instance count: %w", err)
		}
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + 1 WHERE id = ?`,
		newInstanceID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment new instance count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit single server migration: %w", err)
	}

	return nil
}
