package repository

import (
	"context"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
)

type sqliteStorageRepo struct {
	db database.TxQuerier
}

func NewSQLiteStorageRepo(db database.TxQuerier) StorageRepository {
	return &sqliteStorageRepo{db: db}
}

func (r *sqliteStorageRepo) GetOrCreate(ctx context.Context, userID string, defaultQuota int64) (*UserStorage, error) {
	// Upsert: insert if missing, then select.
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO user_storage (user_id, bytes_used, quota_bytes, updated_at)
		 VALUES (?, 0, ?, ?)
		 ON CONFLICT(user_id) DO NOTHING`,
		userID, defaultQuota, time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return nil, fmt.Errorf("storage upsert: %w", err)
	}

	var s UserStorage
	err = r.db.QueryRowContext(ctx,
		`SELECT user_id, bytes_used, quota_bytes, updated_at FROM user_storage WHERE user_id = ?`,
		userID,
	).Scan(&s.UserID, &s.BytesUsed, &s.QuotaBytes, &s.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("storage get: %w", err)
	}
	return &s, nil
}

func (r *sqliteStorageRepo) TryIncrement(ctx context.Context, userID string, bytes int64, defaultQuota int64) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339)

	// Ensure row exists first.
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO user_storage (user_id, bytes_used, quota_bytes, updated_at)
		 VALUES (?, 0, ?, ?)
		 ON CONFLICT(user_id) DO NOTHING`,
		userID, defaultQuota, now,
	)
	if err != nil {
		return false, fmt.Errorf("storage ensure row: %w", err)
	}

	// Atomic increment with quota check.
	result, err := r.db.ExecContext(ctx,
		`UPDATE user_storage
		 SET bytes_used = bytes_used + ?, updated_at = ?
		 WHERE user_id = ? AND bytes_used + ? <= quota_bytes`,
		bytes, now, userID, bytes,
	)
	if err != nil {
		return false, fmt.Errorf("storage try increment: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("storage rows affected: %w", err)
	}
	return rows > 0, nil
}

func (r *sqliteStorageRepo) Decrement(ctx context.Context, userID string, bytes int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := r.db.ExecContext(ctx,
		`UPDATE user_storage
		 SET bytes_used = MAX(0, bytes_used - ?), updated_at = ?
		 WHERE user_id = ?`,
		bytes, now, userID,
	)
	if err != nil {
		return fmt.Errorf("storage decrement: %w", err)
	}
	return nil
}

func (r *sqliteStorageRepo) SetQuota(ctx context.Context, userID string, quotaBytes int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	result, err := r.db.ExecContext(ctx,
		`UPDATE user_storage SET quota_bytes = ?, updated_at = ? WHERE user_id = ?`,
		quotaBytes, now, userID,
	)
	if err != nil {
		return fmt.Errorf("storage set quota: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		// User has no storage row yet — create with the specified quota.
		_, err = r.db.ExecContext(ctx,
			`INSERT INTO user_storage (user_id, bytes_used, quota_bytes, updated_at)
			 VALUES (?, 0, ?, ?)`,
			userID, quotaBytes, now,
		)
		if err != nil {
			return fmt.Errorf("storage create with quota: %w", err)
		}
	}
	return nil
}

func (r *sqliteStorageRepo) SetBytesUsed(ctx context.Context, userID string, bytesUsed int64, defaultQuota int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO user_storage (user_id, bytes_used, quota_bytes, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET bytes_used = excluded.bytes_used, updated_at = excluded.updated_at`,
		userID, bytesUsed, defaultQuota, now,
	)
	if err != nil {
		return fmt.Errorf("storage set bytes_used: %w", err)
	}
	return nil
}

// Ensure interface compliance.
var _ StorageRepository = (*sqliteStorageRepo)(nil)
