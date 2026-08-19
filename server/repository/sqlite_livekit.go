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
		INSERT INTO livekit_instances (id, url, api_key, api_secret, is_platform_managed, server_count, max_servers, hetzner_server_id, region)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query,
		generatedID, instance.URL, instance.APIKey, instance.APISecret,
		instance.IsPlatformManaged, instance.ServerCount, instance.MaxServers, instance.HetznerServerID,
		instance.Region,
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
	// Counted live rather than read from the stored server_count column, which drifts. Aliased to a
	// different name so the two can never shadow each other in an expression - see liveServerCount.
	query := `
		SELECT id, url, api_key, api_secret, is_platform_managed,
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS live_server_count,
		       max_servers, hetzner_server_id, region, created_at
		FROM livekit_instances WHERE id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.Region, &inst.CreatedAt,
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
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = li.id) AS live_server_count,
		       li.max_servers, li.hetzner_server_id, li.created_at
		FROM livekit_instances li
		INNER JOIN servers s ON s.livekit_instance_id = li.id
		WHERE s.id = ?`

	inst := &models.LiveKitInstance{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.Region, &inst.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance by server: %w", err)
	}

	return inst, nil
}

// liveServerCount counts servers actually pointing at the instance.
//
// It is spelled out rather than reused through the SELECT alias on purpose. `livekit_instances` has
// a *stored* `server_count` column, maintained by Increment/DecrementServerCount and read by nobody
// who decides anything, and inside a SQL expression that real column shadows an output alias of the
// same name. Writing `server_count < max_servers` therefore compares against the stale stored value
// — which is 0 for every row these queries can see — so the capacity test silently always passed.
// The alias below is named differently so the two can never be confused again.
const liveServerCount = `(SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id)`

// platformInstanceColumns is the shared SELECT list for the two platform-instance queries below.
const platformInstanceColumns = `
		SELECT id, url, api_key, api_secret, is_platform_managed,
		       ` + liveServerCount + ` AS live_server_count,
		       max_servers, hetzner_server_id, region, created_at
		FROM livekit_instances
		WHERE is_platform_managed = 1`

// hasRoom is true when an instance is under its max_servers cap. 0 means unlimited.
const hasRoom = `(max_servers = 0 OR ` + liveServerCount + ` < max_servers)`

func (r *sqliteLiveKitRepo) scanPlatformInstance(row *sql.Row, what string) (*models.LiveKitInstance, error) {
	inst := &models.LiveKitInstance{}
	err := row.Scan(
		&inst.ID, &inst.URL, &inst.APIKey, &inst.APISecret,
		&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.Region, &inst.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get %s: %w", what, err)
	}
	return inst, nil
}

// GetLeastLoadedPlatformInstance picks an instance to register a new server on.
//
// Capacity is a hard filter here, and deliberately so: the question is literally "can this instance
// take another server", max_servers is denominated in servers, and running out is a real answer —
// the caller degrades the new server to no-voice rather than overfilling an instance.
func (r *sqliteLiveKitRepo) GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error) {
	query := platformInstanceColumns + `
		  AND ` + hasRoom + `
		ORDER BY live_server_count ASC
		LIMIT 1`

	return r.scanPlatformInstance(r.db.QueryRowContext(ctx, query), "least loaded platform instance")
}

// GetPlatformInstanceForRegion picks where a voice call should be hosted.
//
// Three ordering terms, and the order between them is the whole policy:
//
//  1. Region, absolute. A caller whose region has an instance stays there no matter how busy it is.
//     Being nearer beats being emptier — a European must not be sent to Virginia because Virginia
//     happens to be idle.
//  2. Room, within the region. Preferred, never required.
//  3. Load, as the tie-break.
//
// Nothing here is a WHERE clause, so this cannot refuse. A region with no instance, or one whose
// instances are all at their cap, still yields somebody — placement must never be the reason a
// person cannot talk. That is also why capacity is only a preference: max_servers counts registered
// servers, which is unrelated to how many people an SFU is carrying right now, so it is far too
// crude a signal to exile a caller across an ocean with.
func (r *sqliteLiveKitRepo) GetPlatformInstanceForRegion(ctx context.Context, region string) (*models.LiveKitInstance, error) {
	query := platformInstanceColumns + `
		ORDER BY (region = ? AND ? != '') DESC, ` + hasRoom + ` DESC, live_server_count ASC
		LIMIT 1`

	return r.scanPlatformInstance(r.db.QueryRowContext(ctx, query, region, region), "platform instance for region")
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
	query := `UPDATE livekit_instances SET url = ?, api_key = ?, api_secret = ?, max_servers = ?, hetzner_server_id = ?, region = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		instance.URL, instance.APIKey, instance.APISecret, instance.MaxServers, instance.HetznerServerID,
		instance.Region, instance.ID,
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
		       (SELECT COUNT(*) FROM servers WHERE livekit_instance_id = livekit_instances.id) AS live_server_count,
		       max_servers, hetzner_server_id, region, created_at
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
			&inst.IsPlatformManaged, &inst.ServerCount, &inst.MaxServers, &inst.HetznerServerID, &inst.Region, &inst.CreatedAt,
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

// GetChannelBinding returns the instance a channel is bound to, or pkg.ErrNotFound when it has
// none — which is the normal state for a channel nobody is in.
func (r *sqliteLiveKitRepo) GetChannelBinding(ctx context.Context, channelID string) (string, error) {
	var instanceID string
	err := r.db.QueryRowContext(ctx,
		`SELECT instance_id FROM channel_voice_bindings WHERE channel_id = ?`, channelID,
	).Scan(&instanceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", pkg.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("get channel binding %s: %w", channelID, err)
	}
	return instanceID, nil
}

// SetChannelBinding records the claim. Upsert rather than insert: a restart can re-adopt a binding
// it already holds, and racing that against the row already existing must not fail the join.
func (r *sqliteLiveKitRepo) SetChannelBinding(ctx context.Context, channelID, instanceID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO channel_voice_bindings (channel_id, instance_id) VALUES (?, ?)
		 ON CONFLICT(channel_id) DO UPDATE SET instance_id = excluded.instance_id`,
		channelID, instanceID,
	)
	if err != nil {
		return fmt.Errorf("set channel binding %s -> %s: %w", channelID, instanceID, err)
	}
	return nil
}

func (r *sqliteLiveKitRepo) ClearChannelBinding(ctx context.Context, channelID, instanceID string) error {
	// Conditional on the instance, because the clear runs off the caller's path while a fresh claim
	// may already have written a new row for the same channel. An unconditional delete arriving
	// late would erase the binding of a call that is currently running: memory would still be
	// right, the table would not, and a restart in that state sends the next joiner to a different
	// instance and splits the room.
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM channel_voice_bindings WHERE channel_id = ? AND instance_id = ?`,
		channelID, instanceID,
	); err != nil {
		return fmt.Errorf("clear channel binding %s: %w", channelID, err)
	}
	return nil
}
