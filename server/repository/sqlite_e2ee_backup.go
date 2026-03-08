package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteE2EEBackupRepo struct {
	db database.TxQuerier
}

func NewSQLiteE2EEBackupRepo(db database.TxQuerier) E2EEKeyBackupRepository {
	return &sqliteE2EEBackupRepo{db: db}
}

func (r *sqliteE2EEBackupRepo) Upsert(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error {
	query := `
		INSERT INTO e2ee_key_backups (user_id, version, algorithm, encrypted_data, nonce, salt)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id)
		DO UPDATE SET
			version = excluded.version,
			algorithm = excluded.algorithm,
			encrypted_data = excluded.encrypted_data,
			nonce = excluded.nonce,
			salt = excluded.salt,
			updated_at = CURRENT_TIMESTAMP`

	_, err := r.db.ExecContext(ctx, query,
		userID, req.Version, req.Algorithm, req.EncryptedData, req.Nonce, req.Salt,
	)
	if err != nil {
		return fmt.Errorf("failed to upsert key backup: %w", err)
	}
	return nil
}

func (r *sqliteE2EEBackupRepo) GetByUser(ctx context.Context, userID string) (*models.E2EEKeyBackup, error) {
	query := `
		SELECT id, user_id, version, algorithm, encrypted_data, nonce, salt, created_at, updated_at
		FROM e2ee_key_backups
		WHERE user_id = ?`

	b := &models.E2EEKeyBackup{}
	err := r.db.QueryRowContext(ctx, query, userID).Scan(
		&b.ID, &b.UserID, &b.Version, &b.Algorithm,
		&b.EncryptedData, &b.Nonce, &b.Salt,
		&b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get key backup: %w", err)
	}
	return b, nil
}

func (r *sqliteE2EEBackupRepo) Delete(ctx context.Context, userID string) error {
	query := `DELETE FROM e2ee_key_backups WHERE user_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID)
	if err != nil {
		return fmt.Errorf("failed to delete key backup: %w", err)
	}
	return nil
}

var _ E2EEKeyBackupRepository = (*sqliteE2EEBackupRepo)(nil)
