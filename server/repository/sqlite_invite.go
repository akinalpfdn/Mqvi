// Package repository — InviteRepository'nin SQLite implementasyonu.
//
// Davet kodları CRUD işlemleri.
// invites tablosu 001_init.sql'de oluşturuldu:
//   code (PK), created_by, max_uses, uses, expires_at, created_at
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteInviteRepo struct {
	db *sql.DB
}

// NewSQLiteInviteRepo, constructor.
func NewSQLiteInviteRepo(db *sql.DB) InviteRepository {
	return &sqliteInviteRepo{db: db}
}

// GetByCode, belirli bir davet kodunu döner.
func (r *sqliteInviteRepo) GetByCode(ctx context.Context, code string) (*models.Invite, error) {
	query := `SELECT code, created_by, max_uses, uses, expires_at, created_at
              FROM invites WHERE code = ?`

	invite := &models.Invite{}
	err := r.db.QueryRowContext(ctx, query, code).Scan(
		&invite.Code, &invite.CreatedBy, &invite.MaxUses,
		&invite.Uses, &invite.ExpiresAt, &invite.CreatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get invite: %w", err)
	}

	return invite, nil
}

// List, tüm davet kodlarını oluşturan kullanıcı bilgisiyle döner.
// LEFT JOIN ile oluşturanın username/display_name'i alınır.
// Kullanıcı silinmişse (ON DELETE SET NULL) created_by NULL olabilir.
func (r *sqliteInviteRepo) List(ctx context.Context) ([]models.InviteWithCreator, error) {
	query := `SELECT i.code, i.created_by, i.max_uses, i.uses, i.expires_at, i.created_at,
                     COALESCE(u.username, ''), u.display_name
              FROM invites i
              LEFT JOIN users u ON u.id = i.created_by
              ORDER BY i.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list invites: %w", err)
	}
	defer rows.Close()

	var invites []models.InviteWithCreator
	for rows.Next() {
		var inv models.InviteWithCreator
		if err := rows.Scan(
			&inv.Code, &inv.CreatedBy, &inv.MaxUses,
			&inv.Uses, &inv.ExpiresAt, &inv.CreatedAt,
			&inv.CreatorUsername, &inv.CreatorDisplayName,
		); err != nil {
			return nil, fmt.Errorf("failed to scan invite: %w", err)
		}
		invites = append(invites, inv)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate invites: %w", err)
	}

	return invites, nil
}

// Create, yeni bir davet kodu oluşturur.
func (r *sqliteInviteRepo) Create(ctx context.Context, invite *models.Invite) error {
	query := `INSERT INTO invites (code, created_by, max_uses, uses, expires_at)
              VALUES (?, ?, ?, 0, ?)`

	_, err := r.db.ExecContext(ctx, query,
		invite.Code, invite.CreatedBy, invite.MaxUses, invite.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create invite: %w", err)
	}

	return nil
}

// Delete, bir davet kodunu siler.
func (r *sqliteInviteRepo) Delete(ctx context.Context, code string) error {
	query := `DELETE FROM invites WHERE code = ?`

	result, err := r.db.ExecContext(ctx, query, code)
	if err != nil {
		return fmt.Errorf("failed to delete invite: %w", err)
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

// IncrementUses, davet kodunun kullanım sayısını 1 artırır.
func (r *sqliteInviteRepo) IncrementUses(ctx context.Context, code string) error {
	query := `UPDATE invites SET uses = uses + 1 WHERE code = ?`

	result, err := r.db.ExecContext(ctx, query, code)
	if err != nil {
		return fmt.Errorf("failed to increment invite uses: %w", err)
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
