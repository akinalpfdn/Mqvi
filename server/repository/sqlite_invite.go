package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteInviteRepo struct {
	db database.TxQuerier
}

func NewSQLiteInviteRepo(db database.TxQuerier) InviteRepository {
	return &sqliteInviteRepo{db: db}
}

func (r *sqliteInviteRepo) GetByCode(ctx context.Context, code string) (*models.Invite, error) {
	query := `
		SELECT code, server_id, created_by, max_uses, uses, expires_at, created_at
		FROM invites WHERE code = ?`

	invite := &models.Invite{}
	err := r.db.QueryRowContext(ctx, query, code).Scan(
		&invite.Code, &invite.ServerID, &invite.CreatedBy, &invite.MaxUses,
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

// ListByServer returns a server's invites with creator info via LEFT JOIN.
func (r *sqliteInviteRepo) ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error) {
	query := `
		SELECT i.code, i.server_id, i.created_by, i.max_uses, i.uses, i.expires_at, i.created_at,
		       COALESCE(u.username, ''), u.display_name
		FROM invites i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.server_id = ?
		ORDER BY i.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list invites: %w", err)
	}
	defer rows.Close()

	var invites []models.InviteWithCreator
	for rows.Next() {
		var inv models.InviteWithCreator
		if err := rows.Scan(
			&inv.Code, &inv.ServerID, &inv.CreatedBy, &inv.MaxUses,
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

func (r *sqliteInviteRepo) Create(ctx context.Context, invite *models.Invite) error {
	query := `
		INSERT INTO invites (code, server_id, created_by, max_uses, uses, expires_at)
		VALUES (?, ?, ?, ?, 0, ?)`

	_, err := r.db.ExecContext(ctx, query,
		invite.Code, invite.ServerID, invite.CreatedBy, invite.MaxUses, invite.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create invite: %w", err)
	}

	return nil
}

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
