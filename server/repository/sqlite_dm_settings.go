// Package repository — DMSettingsRepository SQLite implementasyonu.
//
// UPSERT pattern: INSERT ... ON CONFLICT DO UPDATE.
//
// Mute sentinel: Forever mute'ta muted_until = '9999-12-31T23:59:59Z' kullanılır.
// Bu dm_settings tablosu pin/hide için de satır oluşturabildiğinden, NULL "muted değil"
// anlamına gelir, sentinel ise "sonsuz mute" anlamına gelir. Süreli mute'lar normal
// datetime string'i tutar. Lazy expiry: WHERE muted_until > datetime('now').
package repository

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/database"
)

// sqliteDMSettingsRepo, DMSettingsRepository interface'inin SQLite implementasyonu.
type sqliteDMSettingsRepo struct {
	db database.TxQuerier
}

// NewSQLiteDMSettingsRepo, constructor — interface döner.
func NewSQLiteDMSettingsRepo(db database.TxQuerier) DMSettingsRepository {
	return &sqliteDMSettingsRepo{db: db}
}

// IsHidden, DM'nin gizli olup olmadığını döner.
// Satır yoksa false (gizli değil). Auto-unhide öncesi kontrol — gereksiz broadcast önleme.
func (r *sqliteDMSettingsRepo) IsHidden(ctx context.Context, userID, dmChannelID string) (bool, error) {
	query := `
		SELECT is_hidden FROM user_dm_settings
		WHERE user_id = ? AND dm_channel_id = ?`

	var isHidden bool
	err := r.db.QueryRowContext(ctx, query, userID, dmChannelID).Scan(&isHidden)
	if err != nil {
		// Satır yoksa gizli değil
		return false, nil
	}
	return isHidden, nil
}

// SetHidden, DM'yi gizle veya göster.
func (r *sqliteDMSettingsRepo) SetHidden(ctx context.Context, userID, dmChannelID string, hidden bool) error {
	hiddenInt := 0
	if hidden {
		hiddenInt = 1
	}
	query := `
		INSERT INTO user_dm_settings (user_id, dm_channel_id, is_hidden)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET is_hidden = excluded.is_hidden`

	_, err := r.db.ExecContext(ctx, query, userID, dmChannelID, hiddenInt)
	if err != nil {
		return fmt.Errorf("failed to set DM hidden: %w", err)
	}
	return nil
}

// SetPinned, DM'yi sabitle veya sabitlemeyi kaldır.
func (r *sqliteDMSettingsRepo) SetPinned(ctx context.Context, userID, dmChannelID string, pinned bool) error {
	pinnedInt := 0
	if pinned {
		pinnedInt = 1
	}
	query := `
		INSERT INTO user_dm_settings (user_id, dm_channel_id, is_pinned)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET is_pinned = excluded.is_pinned`

	_, err := r.db.ExecContext(ctx, query, userID, dmChannelID, pinnedInt)
	if err != nil {
		return fmt.Errorf("failed to set DM pinned: %w", err)
	}
	return nil
}

// SetMutedUntil, DM'yi sessize al.
// mutedUntil: datetime string (süreli) veya '9999-12-31T23:59:59Z' (forever).
func (r *sqliteDMSettingsRepo) SetMutedUntil(ctx context.Context, userID, dmChannelID string, mutedUntil *string) error {
	query := `
		INSERT INTO user_dm_settings (user_id, dm_channel_id, muted_until)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, dm_channel_id)
		DO UPDATE SET muted_until = excluded.muted_until`

	_, err := r.db.ExecContext(ctx, query, userID, dmChannelID, mutedUntil)
	if err != nil {
		return fmt.Errorf("failed to set DM muted: %w", err)
	}
	return nil
}

// DeleteMute, DM mute'u kaldır (muted_until = NULL).
func (r *sqliteDMSettingsRepo) DeleteMute(ctx context.Context, userID, dmChannelID string) error {
	query := `
		UPDATE user_dm_settings
		SET muted_until = NULL
		WHERE user_id = ? AND dm_channel_id = ?`

	_, err := r.db.ExecContext(ctx, query, userID, dmChannelID)
	if err != nil {
		return fmt.Errorf("failed to delete DM mute: %w", err)
	}
	return nil
}

// GetPinnedChannelIDs, kullanıcının sabitlediği DM kanal ID'lerini döner.
func (r *sqliteDMSettingsRepo) GetPinnedChannelIDs(ctx context.Context, userID string) ([]string, error) {
	query := `
		SELECT dm_channel_id FROM user_dm_settings
		WHERE user_id = ? AND is_pinned = 1`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM channel ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan pinned DM channel id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetMutedChannelIDs, kullanıcının sessize aldığı DM kanal ID'lerini döner.
// Lazy expiry: muted_until > datetime('now') koşulu ile süresi dolmuş mute'lar hariç tutulur.
// Forever mute sentinel '9999-12-31T23:59:59Z' her zaman > now olacağı için dahil edilir.
func (r *sqliteDMSettingsRepo) GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error) {
	query := `
		SELECT dm_channel_id FROM user_dm_settings
		WHERE user_id = ?
		  AND muted_until IS NOT NULL
		  AND muted_until > datetime('now')`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get muted DM channel ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan muted DM channel id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
