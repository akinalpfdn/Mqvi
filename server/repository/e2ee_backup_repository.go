package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// E2EEKeyBackupRepository defines data access for encrypted key backups.
// The server stores an opaque encrypted blob -- it never sees the recovery password or raw keys.
type E2EEKeyBackupRepository interface {
	// Upsert creates or updates the backup. Each user has at most one backup (UNIQUE user_id).
	Upsert(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error
	// GetByUser returns the backup or nil if none exists.
	GetByUser(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)
	Delete(ctx context.Context, userID string) error
}
