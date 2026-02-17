package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
)

// sqliteChannelPermRepo, ChannelPermissionRepository'nin SQLite implementasyonu.
//
// channel_permissions tablosu 001_init.sql'de tanımlı:
//
//	PRIMARY KEY (channel_id, role_id) → her kanal-rol çifti için tek override
//	allow INTEGER → izin verilen permission bit'leri
//	deny INTEGER  → engellenen permission bit'leri
type sqliteChannelPermRepo struct {
	db *sql.DB
}

// NewSQLiteChannelPermRepo, SQLite tabanlı ChannelPermissionRepository oluşturur.
func NewSQLiteChannelPermRepo(db *sql.DB) ChannelPermissionRepository {
	return &sqliteChannelPermRepo{db: db}
}

func (r *sqliteChannelPermRepo) GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	query := `SELECT channel_id, role_id, allow, deny FROM channel_permissions WHERE channel_id = ?`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel permissions: %w", err)
	}
	defer rows.Close()

	var overrides []models.ChannelPermissionOverride
	for rows.Next() {
		var o models.ChannelPermissionOverride
		if err := rows.Scan(&o.ChannelID, &o.RoleID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("failed to scan channel permission row: %w", err)
		}
		overrides = append(overrides, o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel permission rows: %w", err)
	}

	return overrides, nil
}

func (r *sqliteChannelPermRepo) GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if len(roleIDs) == 0 {
		return nil, nil
	}

	// Dinamik placeholder oluşturma: IN (?, ?, ?)
	// SQLite'da parametre sayısı değişken olduğunda placeholder'ları
	// programatik oluşturmamız gerekir.
	placeholders := make([]string, len(roleIDs))
	args := make([]any, 0, len(roleIDs)+1)
	args = append(args, channelID)
	for i, id := range roleIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	query := fmt.Sprintf(
		`SELECT channel_id, role_id, allow, deny FROM channel_permissions WHERE channel_id = ? AND role_id IN (%s)`,
		strings.Join(placeholders, ","),
	)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get channel permissions by roles: %w", err)
	}
	defer rows.Close()

	var overrides []models.ChannelPermissionOverride
	for rows.Next() {
		var o models.ChannelPermissionOverride
		if err := rows.Scan(&o.ChannelID, &o.RoleID, &o.Allow, &o.Deny); err != nil {
			return nil, fmt.Errorf("failed to scan channel permission row: %w", err)
		}
		overrides = append(overrides, o)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating channel permission rows: %w", err)
	}

	return overrides, nil
}

func (r *sqliteChannelPermRepo) Set(ctx context.Context, override *models.ChannelPermissionOverride) error {
	// UPSERT: SQLite'ın INSERT OR REPLACE ifadesi.
	// PRIMARY KEY (channel_id, role_id) zaten varsa günceller, yoksa oluşturur.
	//
	// ON CONFLICT ... DO UPDATE SET kullanıyoruz çünkü:
	// - INSERT OR REPLACE, satırı silip yeniden oluşturur (FK cascade tetikleyebilir)
	// - ON CONFLICT ... DO UPDATE sadece belirtilen sütunları günceller (daha güvenli)
	query := `
		INSERT INTO channel_permissions (channel_id, role_id, allow, deny)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (channel_id, role_id) DO UPDATE SET
			allow = excluded.allow,
			deny = excluded.deny`

	_, err := r.db.ExecContext(ctx, query,
		override.ChannelID, override.RoleID, override.Allow, override.Deny,
	)
	if err != nil {
		return fmt.Errorf("failed to set channel permission: %w", err)
	}

	return nil
}

func (r *sqliteChannelPermRepo) Delete(ctx context.Context, channelID, roleID string) error {
	query := `DELETE FROM channel_permissions WHERE channel_id = ? AND role_id = ?`

	result, err := r.db.ExecContext(ctx, query, channelID, roleID)
	if err != nil {
		return fmt.Errorf("failed to delete channel permission: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		// Override yoksa sessizce geçmek yerine hata dönüyoruz,
		// böylece handler 404 dönebilir (REST semantiği).
		return fmt.Errorf("channel permission override not found")
	}

	return nil
}

func (r *sqliteChannelPermRepo) DeleteAllByChannel(ctx context.Context, channelID string) error {
	query := `DELETE FROM channel_permissions WHERE channel_id = ?`

	_, err := r.db.ExecContext(ctx, query, channelID)
	if err != nil {
		return fmt.Errorf("failed to delete all channel permissions: %w", err)
	}

	// affected == 0 kontrolü yapmıyoruz:
	// Kanal silinirken override olmayabilir, bu normal.
	return nil
}
