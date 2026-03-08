package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// DeviceRepository defines data access for E2EE device registration and prekey management.
type DeviceRepository interface {
	// Register creates or updates a device record (UPSERT on user_id + device_id).
	Register(ctx context.Context, device *models.Device) error
	GetByUserAndDevice(ctx context.Context, userID, deviceID string) (*models.Device, error)
	ListByUser(ctx context.Context, userID string) ([]models.Device, error)
	// ListPublicByUser returns public device info (excludes private keys/signatures).
	ListPublicByUser(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)
	// Delete removes a device and its prekeys (CASCADE).
	Delete(ctx context.Context, userID, deviceID string) error
	UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error
	UpdateLastSeen(ctx context.Context, userID, deviceID string) error

	// --- One-Time Prekey operations ---

	// UploadPrekeys adds new one-time prekeys (INSERT OR IGNORE on conflicts).
	UploadPrekeys(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error
	// ConsumePrekey atomically consumes the oldest one-time prekey (DELETE + RETURNING). Returns nil if empty.
	ConsumePrekey(ctx context.Context, userID, deviceID string) (*models.OneTimePrekey, error)
	CountPrekeys(ctx context.Context, userID, deviceID string) (int, error)
	// GetPrekeyBundle returns the full X3DH prekey bundle. Consumes a one-time prekey if available.
	GetPrekeyBundle(ctx context.Context, userID, deviceID string) (*models.PrekeyBundle, error)
	// GetPrekeyBundles returns prekey bundles for all of a user's devices.
	GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
}
