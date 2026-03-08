package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteDeviceRepo struct {
	db database.TxQuerier
}

func NewSQLiteDeviceRepo(db database.TxQuerier) DeviceRepository {
	return &sqliteDeviceRepo{db: db}
}

// Register creates or re-registers a device (upsert on user_id + device_id).
func (r *sqliteDeviceRepo) Register(ctx context.Context, device *models.Device) error {
	query := `
		INSERT INTO user_devices (user_id, device_id, display_name, identity_key, signing_key,
			signed_prekey, signed_prekey_id, signed_prekey_signature, registration_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, device_id)
		DO UPDATE SET
			display_name = excluded.display_name,
			identity_key = excluded.identity_key,
			signing_key = excluded.signing_key,
			signed_prekey = excluded.signed_prekey,
			signed_prekey_id = excluded.signed_prekey_id,
			signed_prekey_signature = excluded.signed_prekey_signature,
			registration_id = excluded.registration_id,
			last_seen_at = CURRENT_TIMESTAMP
		RETURNING id, last_seen_at, created_at`

	err := r.db.QueryRowContext(ctx, query,
		device.UserID, device.DeviceID, device.DisplayName, device.IdentityKey, device.SigningKey,
		device.SignedPrekey, device.SignedPrekeyID, device.SignedPrekeySig,
		device.RegistrationID,
	).Scan(&device.ID, &device.LastSeenAt, &device.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to register device: %w", err)
	}
	return nil
}

func (r *sqliteDeviceRepo) GetByUserAndDevice(ctx context.Context, userID, deviceID string) (*models.Device, error) {
	query := `
		SELECT id, user_id, device_id, display_name, identity_key, signing_key,
			signed_prekey, signed_prekey_id, signed_prekey_signature,
			registration_id, last_seen_at, created_at
		FROM user_devices
		WHERE user_id = ? AND device_id = ?`

	d := &models.Device{}
	err := r.db.QueryRowContext(ctx, query, userID, deviceID).Scan(
		&d.ID, &d.UserID, &d.DeviceID, &d.DisplayName, &d.IdentityKey, &d.SigningKey,
		&d.SignedPrekey, &d.SignedPrekeyID, &d.SignedPrekeySig,
		&d.RegistrationID, &d.LastSeenAt, &d.CreatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, pkg.ErrNotFound
		}
		return nil, fmt.Errorf("failed to get device: %w", err)
	}
	return d, nil
}

func (r *sqliteDeviceRepo) ListByUser(ctx context.Context, userID string) ([]models.Device, error) {
	query := `
		SELECT id, user_id, device_id, display_name, identity_key, signing_key,
			signed_prekey, signed_prekey_id, signed_prekey_signature,
			registration_id, last_seen_at, created_at
		FROM user_devices
		WHERE user_id = ?
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list devices: %w", err)
	}
	defer rows.Close()

	var devices []models.Device
	for rows.Next() {
		var d models.Device
		if err := rows.Scan(
			&d.ID, &d.UserID, &d.DeviceID, &d.DisplayName, &d.IdentityKey, &d.SigningKey,
			&d.SignedPrekey, &d.SignedPrekeyID, &d.SignedPrekeySig,
			&d.RegistrationID, &d.LastSeenAt, &d.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan device: %w", err)
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (r *sqliteDeviceRepo) ListPublicByUser(ctx context.Context, userID string) ([]models.DevicePublicInfo, error) {
	query := `
		SELECT device_id, display_name, identity_key, created_at, last_seen_at
		FROM user_devices
		WHERE user_id = ?
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list public devices: %w", err)
	}
	defer rows.Close()

	var devices []models.DevicePublicInfo
	for rows.Next() {
		var d models.DevicePublicInfo
		if err := rows.Scan(&d.DeviceID, &d.DisplayName, &d.IdentityKey, &d.CreatedAt, &d.LastSeenAt); err != nil {
			return nil, fmt.Errorf("failed to scan public device: %w", err)
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// Delete removes a device. Prekeys are cascade-deleted.
func (r *sqliteDeviceRepo) Delete(ctx context.Context, userID, deviceID string) error {
	query := `DELETE FROM user_devices WHERE user_id = ? AND device_id = ?`
	result, err := r.db.ExecContext(ctx, query, userID, deviceID)
	if err != nil {
		return fmt.Errorf("failed to delete device: %w", err)
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

func (r *sqliteDeviceRepo) UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error {
	query := `
		UPDATE user_devices
		SET signed_prekey = ?, signed_prekey_id = ?, signed_prekey_signature = ?,
			last_seen_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND device_id = ?`

	result, err := r.db.ExecContext(ctx, query,
		req.SignedPrekey, req.SignedPrekeyID, req.SignedPrekeySig,
		userID, deviceID,
	)
	if err != nil {
		return fmt.Errorf("failed to update signed prekey: %w", err)
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

func (r *sqliteDeviceRepo) UpdateLastSeen(ctx context.Context, userID, deviceID string) error {
	query := `UPDATE user_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE user_id = ? AND device_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID, deviceID)
	if err != nil {
		return fmt.Errorf("failed to update device last seen: %w", err)
	}
	return nil
}

// UploadPrekeys batch-inserts one-time prekeys. Duplicates are silently ignored.
func (r *sqliteDeviceRepo) UploadPrekeys(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error {
	query := `
		INSERT OR IGNORE INTO device_one_time_prekeys (user_id, device_id, prekey_id, public_key)
		VALUES (?, ?, ?, ?)`

	for _, pk := range prekeys {
		_, err := r.db.ExecContext(ctx, query, userID, deviceID, pk.PrekeyID, pk.PublicKey)
		if err != nil {
			return fmt.Errorf("failed to upload prekey %d: %w", pk.PrekeyID, err)
		}
	}
	return nil
}

// ConsumePrekey atomically deletes and returns the oldest prekey.
// Returns nil if pool is empty (X3DH falls back to 3-DH).
func (r *sqliteDeviceRepo) ConsumePrekey(ctx context.Context, userID, deviceID string) (*models.OneTimePrekey, error) {
	query := `
		DELETE FROM device_one_time_prekeys
		WHERE id = (
			SELECT id FROM device_one_time_prekeys
			WHERE user_id = ? AND device_id = ?
			ORDER BY created_at ASC
			LIMIT 1
		)
		RETURNING id, device_id, user_id, prekey_id, public_key, created_at`

	var pk models.OneTimePrekey
	err := r.db.QueryRowContext(ctx, query, userID, deviceID).Scan(
		&pk.ID, &pk.DeviceID, &pk.UserID, &pk.PrekeyID, &pk.PublicKey, &pk.CreatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to consume prekey: %w", err)
	}
	return &pk, nil
}

func (r *sqliteDeviceRepo) CountPrekeys(ctx context.Context, userID, deviceID string) (int, error) {
	query := `SELECT COUNT(*) FROM device_one_time_prekeys WHERE user_id = ? AND device_id = ?`
	var count int
	err := r.db.QueryRowContext(ctx, query, userID, deviceID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count prekeys: %w", err)
	}
	return count, nil
}

// GetPrekeyBundle returns a full X3DH prekey bundle, consuming one OTP if available.
func (r *sqliteDeviceRepo) GetPrekeyBundle(ctx context.Context, userID, deviceID string) (*models.PrekeyBundle, error) {
	query := `
		SELECT device_id, registration_id, identity_key, signing_key,
			signed_prekey_id, signed_prekey, signed_prekey_signature
		FROM user_devices
		WHERE user_id = ? AND device_id = ?`

	bundle := &models.PrekeyBundle{}
	err := r.db.QueryRowContext(ctx, query, userID, deviceID).Scan(
		&bundle.DeviceID, &bundle.RegistrationID, &bundle.IdentityKey, &bundle.SigningKey,
		&bundle.SignedPrekeyID, &bundle.SignedPrekey, &bundle.SignedPrekeySig,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, pkg.ErrNotFound
		}
		return nil, fmt.Errorf("failed to get prekey bundle: %w", err)
	}

	otp, err := r.ConsumePrekey(ctx, userID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("failed to consume prekey for bundle: %w", err)
	}
	if otp != nil {
		bundle.OneTimePrekeyID = &otp.PrekeyID
		bundle.OneTimePrekey = &otp.PublicKey
	}

	return bundle, nil
}

// GetPrekeyBundles returns prekey bundles for all of a user's devices.
func (r *sqliteDeviceRepo) GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error) {
	query := `
		SELECT device_id, registration_id, identity_key, signing_key,
			signed_prekey_id, signed_prekey, signed_prekey_signature
		FROM user_devices
		WHERE user_id = ?
		ORDER BY created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list devices for bundles: %w", err)
	}
	defer rows.Close()

	var bundles []models.PrekeyBundle
	for rows.Next() {
		var b models.PrekeyBundle
		if err := rows.Scan(
			&b.DeviceID, &b.RegistrationID, &b.IdentityKey, &b.SigningKey,
			&b.SignedPrekeyID, &b.SignedPrekey, &b.SignedPrekeySig,
		); err != nil {
			return nil, fmt.Errorf("failed to scan device for bundle: %w", err)
		}
		bundles = append(bundles, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range bundles {
		otp, err := r.ConsumePrekey(ctx, userID, bundles[i].DeviceID)
		if err != nil {
			return nil, fmt.Errorf("failed to consume prekey for device %s: %w", bundles[i].DeviceID, err)
		}
		if otp != nil {
			bundles[i].OneTimePrekeyID = &otp.PrekeyID
			bundles[i].OneTimePrekey = &otp.PublicKey
		}
	}

	if len(bundles) == 0 {
		return nil, nil
	}

	return bundles, nil
}

var _ DeviceRepository = (*sqliteDeviceRepo)(nil)
