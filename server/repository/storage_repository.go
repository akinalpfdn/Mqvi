package repository

import "context"

// UserStorage represents a user's storage usage record.
type UserStorage struct {
	UserID     string
	BytesUsed  int64
	QuotaBytes int64
	UpdatedAt  string
}

// StorageRepository manages per-user storage quota tracking.
type StorageRepository interface {
	// GetOrCreate returns the user's storage record, creating one with defaults if absent.
	GetOrCreate(ctx context.Context, userID string, defaultQuota int64) (*UserStorage, error)

	// TryIncrement atomically increments bytes_used if the result stays within quota.
	// Returns false if the increment would exceed the quota (no row updated).
	TryIncrement(ctx context.Context, userID string, bytes int64, defaultQuota int64) (bool, error)

	// Decrement reduces bytes_used (floor at 0).
	Decrement(ctx context.Context, userID string, bytes int64) error

	// SetQuota updates the quota for a user (admin use).
	SetQuota(ctx context.Context, userID string, quotaBytes int64) error

	// SetBytesUsed sets bytes_used directly (reconciliation).
	// defaultQuota is used when creating a new row for a user without one.
	SetBytesUsed(ctx context.Context, userID string, bytesUsed int64, defaultQuota int64) error
}
