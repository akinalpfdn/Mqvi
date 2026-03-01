// Package repository — ServerRepository'nin SQLite implementasyonu.
//
// Çoklu sunucu mimarisi: servers + server_members tabloları.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteServerRepo struct {
	db *sql.DB
}

// NewSQLiteServerRepo, constructor.
func NewSQLiteServerRepo(db *sql.DB) ServerRepository {
	return &sqliteServerRepo{db: db}
}

// ─── Server CRUD ───

func (r *sqliteServerRepo) Create(ctx context.Context, server *models.Server) error {
	query := `
		INSERT INTO servers (id, name, icon_url, owner_id, invite_required, livekit_instance_id)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		server.Name, server.IconURL, server.OwnerID,
		server.InviteRequired, server.LiveKitInstanceID,
	).Scan(&server.ID, &server.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create server: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) GetByID(ctx context.Context, serverID string) (*models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, invite_required, livekit_instance_id, created_at
		FROM servers WHERE id = ?`

	s := &models.Server{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
		&s.InviteRequired, &s.LiveKitInstanceID, &s.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get server: %w", err)
	}

	return s, nil
}

func (r *sqliteServerRepo) Update(ctx context.Context, server *models.Server) error {
	query := `
		UPDATE servers SET name = ?, icon_url = ?, invite_required = ?, livekit_instance_id = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		server.Name, server.IconURL, server.InviteRequired,
		server.LiveKitInstanceID, server.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server: %w", err)
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

func (r *sqliteServerRepo) Delete(ctx context.Context, serverID string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, serverID)
	if err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
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

// ─── Üyelik ───

func (r *sqliteServerRepo) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	// position'a göre sırala — kullanıcının kendi sıralama tercihi.
	// Aynı position değerine sahip sunucular (migration sonrası edge case)
	// joined_at ile tiebreak yapılır.
	query := `
		SELECT s.id, s.name, s.icon_url
		FROM servers s
		INNER JOIN server_members sm ON s.id = sm.server_id
		WHERE sm.user_id = ?
		ORDER BY sm.position ASC, sm.joined_at ASC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user servers: %w", err)
	}
	defer rows.Close()

	var servers []models.ServerListItem
	for rows.Next() {
		var s models.ServerListItem
		if err := rows.Scan(&s.ID, &s.Name, &s.IconURL); err != nil {
			return nil, fmt.Errorf("failed to scan server row: %w", err)
		}
		servers = append(servers, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating server rows: %w", err)
	}

	return servers, nil
}

func (r *sqliteServerRepo) AddMember(ctx context.Context, serverID, userID string) error {
	// Yeni üye her zaman listenin sonuna eklenir.
	// position = mevcut max position + 1 (hiç sunucu yoksa 0).
	// Subquery ile atomic yapıyoruz — ayrı SELECT + INSERT yerine tek sorgu.
	query := `
		INSERT OR IGNORE INTO server_members (server_id, user_id, position)
		VALUES (?, ?, COALESCE((SELECT MAX(position) FROM server_members WHERE user_id = ?), -1) + 1)`

	_, err := r.db.ExecContext(ctx, query, serverID, userID, userID)
	if err != nil {
		return fmt.Errorf("failed to add server member: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) RemoveMember(ctx context.Context, serverID, userID string) error {
	query := `DELETE FROM server_members WHERE server_id = ? AND user_id = ?`

	result, err := r.db.ExecContext(ctx, query, serverID, userID)
	if err != nil {
		return fmt.Errorf("failed to remove server member: %w", err)
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

func (r *sqliteServerRepo) IsMember(ctx context.Context, serverID, userID string) (bool, error) {
	query := `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? LIMIT 1`

	var dummy int
	err := r.db.QueryRowContext(ctx, query, serverID, userID).Scan(&dummy)

	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check server membership: %w", err)
	}

	return true, nil
}

func (r *sqliteServerRepo) GetMemberCount(ctx context.Context, serverID string) (int, error) {
	query := `SELECT COUNT(*) FROM server_members WHERE server_id = ?`

	var count int
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to get member count: %w", err)
	}

	return count, nil
}

func (r *sqliteServerRepo) UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Prepared statement ile her item'ı tek tek güncelle.
	// server_members'da PRIMARY KEY (server_id, user_id) — hem serverID hem userID gerekli.
	stmt, err := tx.PrepareContext(ctx, `UPDATE server_members SET position = ? WHERE server_id = ? AND user_id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare position update: %w", err)
	}
	defer stmt.Close()

	for _, item := range items {
		if _, err := stmt.ExecContext(ctx, item.Position, item.ID, userID); err != nil {
			return fmt.Errorf("failed to update position for server %s: %w", item.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit position update: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) GetMaxMemberPosition(ctx context.Context, userID string) (int, error) {
	query := `SELECT COALESCE(MAX(position), -1) FROM server_members WHERE user_id = ?`

	var maxPos int
	err := r.db.QueryRowContext(ctx, query, userID).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max member position: %w", err)
	}

	return maxPos, nil
}

func (r *sqliteServerRepo) GetMemberServerIDs(ctx context.Context, userID string) ([]string, error) {
	query := `SELECT server_id FROM server_members WHERE user_id = ?`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get member server ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan server id: %w", err)
		}
		ids = append(ids, id)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating server ids: %w", err)
	}

	return ids, nil
}
