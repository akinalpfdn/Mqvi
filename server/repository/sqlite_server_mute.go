package repository

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/database"
)

// sqliteServerMuteRepo, ServerMuteRepository interface'inin SQLite implementasyonu.
type sqliteServerMuteRepo struct {
	db database.TxQuerier
}

// NewSQLiteServerMuteRepo, constructor — interface döner.
func NewSQLiteServerMuteRepo(db database.TxQuerier) ServerMuteRepository {
	return &sqliteServerMuteRepo{db: db}
}

// Upsert, sunucu mute'unu ekler veya günceller.
//
// INSERT OR REPLACE pattern — PK (user_id, server_id) çakışırsa güncellenir.
// mutedUntil nil ise sonsuza kadar sessiz (DATETIME kolonu NULL olur).
func (r *sqliteServerMuteRepo) Upsert(ctx context.Context, userID, serverID string, mutedUntil *string) error {
	query := `
		INSERT INTO server_mutes (user_id, server_id, muted_until)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, server_id)
		DO UPDATE SET muted_until = excluded.muted_until,
		              created_at = CURRENT_TIMESTAMP`

	_, err := r.db.ExecContext(ctx, query, userID, serverID, mutedUntil)
	if err != nil {
		return fmt.Errorf("failed to upsert server mute: %w", err)
	}
	return nil
}

// Delete, sunucu mute'unu kaldırır (unmute).
func (r *sqliteServerMuteRepo) Delete(ctx context.Context, userID, serverID string) error {
	query := `DELETE FROM server_mutes WHERE user_id = ? AND server_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return fmt.Errorf("failed to delete server mute: %w", err)
	}
	return nil
}

// GetMutedServerIDs, kullanıcının aktif mute'lu sunucu ID'lerini döner.
//
// Lazy expiry: WHERE koşuluyla süresi dolmuş mute'lar hariç tutulur.
// muted_until IS NULL → sonsuza kadar muted (dahil et).
// muted_until > datetime('now') → henüz süresi dolmamış (dahil et).
// Diğer durumlar → süresi dolmuş (hariç tut).
func (r *sqliteServerMuteRepo) GetMutedServerIDs(ctx context.Context, userID string) ([]string, error) {
	query := `
		SELECT server_id FROM server_mutes
		WHERE user_id = ?
		  AND (muted_until IS NULL OR muted_until > datetime('now'))`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get muted server ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan muted server id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
