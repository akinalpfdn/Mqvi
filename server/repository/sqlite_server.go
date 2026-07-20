// Package repository — ServerRepository SQLite implementation.
// Multi-server architecture: servers + server_members tables.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteServerRepo struct {
	db database.TxQuerier
}

func NewSQLiteServerRepo(db database.TxQuerier) ServerRepository {
	return &sqliteServerRepo{db: db}
}

// ─── Server CRUD ───

func (r *sqliteServerRepo) Create(ctx context.Context, server *models.Server) error {
	query := `
		INSERT INTO servers (id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required, livekit_instance_id)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		server.Name, server.IconURL, server.OwnerID,
		server.IsPublic, server.E2EEEnabled, server.ApprovalRequired, server.LiveKitInstanceID,
	).Scan(&server.ID, &server.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create server: %w", err)
	}

	return nil
}

func (r *sqliteServerRepo) GetByID(ctx context.Context, serverID string) (*models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required, livekit_instance_id, afk_timeout_minutes,
			deleted_at, deleted_by, deleted_by_admin, created_at,
			description, banner_url, category, verified, featured
		FROM servers WHERE id = ?`

	s := &models.Server{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
		&s.IsPublic, &s.E2EEEnabled, &s.ApprovalRequired, &s.LiveKitInstanceID, &s.AFKTimeoutMinutes,
		&s.DeletedAt, &s.DeletedBy, &s.DeletedByAdmin,
		&s.CreatedAt,
		&s.Description, &s.BannerURL, &s.Category, &s.Verified, &s.Featured,
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
		UPDATE servers SET name = ?, icon_url = ?, banner_url = ?, is_public = ?, e2ee_enabled = ?, approval_required = ?, description = ?, category = ?, livekit_instance_id = ?, afk_timeout_minutes = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		server.Name, server.IconURL, server.BannerURL, server.IsPublic,
		server.E2EEEnabled, server.ApprovalRequired, server.Description, server.Category, server.LiveKitInstanceID, server.AFKTimeoutMinutes, server.ID,
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

// adminDiscoveryFlagColumns whitelists the admin-settable discovery flags → real columns.
var adminDiscoveryFlagColumns = map[string]string{
	"verified":          "verified",
	"featured":          "featured",
	"discovery_blocked": "discovery_blocked",
}

func (r *sqliteServerRepo) SetDiscoveryFlag(ctx context.Context, serverID, flag string, value bool) error {
	col, ok := adminDiscoveryFlagColumns[flag]
	if !ok {
		return fmt.Errorf("%w: unknown discovery flag %q", pkg.ErrBadRequest, flag)
	}
	v := 0
	if value {
		v = 1
	}
	result, err := r.db.ExecContext(ctx,
		fmt.Sprintf("UPDATE servers SET %s = ? WHERE id = ?", col), v, serverID)
	if err != nil {
		return fmt.Errorf("failed to set discovery flag: %w", err)
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

func (r *sqliteServerRepo) GetActiveByID(ctx context.Context, serverID string) (*models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required, livekit_instance_id, afk_timeout_minutes,
			deleted_at, deleted_by, deleted_by_admin, created_at,
			description, banner_url, category, verified, featured
		FROM servers WHERE id = ? AND deleted_at IS NULL`

	s := &models.Server{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
		&s.IsPublic, &s.E2EEEnabled, &s.ApprovalRequired, &s.LiveKitInstanceID, &s.AFKTimeoutMinutes,
		&s.DeletedAt, &s.DeletedBy, &s.DeletedByAdmin,
		&s.CreatedAt,
		&s.Description, &s.BannerURL, &s.Category, &s.Verified, &s.Featured,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get active server: %w", err)
	}
	return s, nil
}

func (r *sqliteServerRepo) SoftDelete(ctx context.Context, serverID, deletedBy string, byAdmin bool) error {
	byAdminInt := 0
	if byAdmin {
		byAdminInt = 1
	}
	result, err := r.db.ExecContext(ctx,
		`UPDATE servers SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, deleted_by_admin = ?
		 WHERE id = ? AND deleted_at IS NULL`,
		deletedBy, byAdminInt, serverID,
	)
	if err != nil {
		return fmt.Errorf("failed to soft delete server: %w", err)
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

func (r *sqliteServerRepo) Restore(ctx context.Context, serverID string) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE servers SET deleted_at = NULL, deleted_by = NULL, deleted_by_admin = 0
		 WHERE id = ? AND deleted_at IS NOT NULL`,
		serverID,
	)
	if err != nil {
		return fmt.Errorf("failed to restore server: %w", err)
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

func (r *sqliteServerRepo) ListDeletedByOwner(ctx context.Context, ownerID string) ([]models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required, livekit_instance_id, afk_timeout_minutes,
			deleted_at, deleted_by, deleted_by_admin, created_at,
			description, banner_url, category, verified, featured
		FROM servers WHERE owner_id = ? AND deleted_at IS NOT NULL
		ORDER BY deleted_at DESC`
	rows, err := r.db.QueryContext(ctx, query, ownerID)
	if err != nil {
		return nil, fmt.Errorf("failed to list deleted servers: %w", err)
	}
	defer rows.Close()

	var servers []models.Server
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(
			&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
			&s.IsPublic, &s.E2EEEnabled, &s.ApprovalRequired, &s.LiveKitInstanceID, &s.AFKTimeoutMinutes,
			&s.DeletedAt, &s.DeletedBy, &s.DeletedByAdmin,
			&s.CreatedAt,
			&s.Description, &s.BannerURL, &s.Category, &s.Verified, &s.Featured,
		); err != nil {
			return nil, fmt.Errorf("failed to scan deleted server: %w", err)
		}
		servers = append(servers, s)
	}
	return servers, rows.Err()
}

func (r *sqliteServerRepo) ListActiveServerIDsByOwner(ctx context.Context, ownerID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id FROM servers WHERE owner_id = ? AND deleted_at IS NULL`, ownerID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list owned server ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan owned server id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (r *sqliteServerRepo) ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.Server, error) {
	query := `
		SELECT id, name, icon_url, owner_id, is_public, e2ee_enabled, approval_required, livekit_instance_id, afk_timeout_minutes,
			deleted_at, deleted_by, deleted_by_admin, created_at,
			description, banner_url, category, verified, featured
		FROM servers
		WHERE deleted_at IS NOT NULL
		  AND deleted_at < datetime('now', ?)
		ORDER BY deleted_at ASC`
	rows, err := r.db.QueryContext(ctx, query, fmt.Sprintf("-%d days", ttlDays))
	if err != nil {
		return nil, fmt.Errorf("failed to list expired soft-deleted servers: %w", err)
	}
	defer rows.Close()

	var servers []models.Server
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(
			&s.ID, &s.Name, &s.IconURL, &s.OwnerID,
			&s.IsPublic, &s.E2EEEnabled, &s.ApprovalRequired, &s.LiveKitInstanceID, &s.AFKTimeoutMinutes,
			&s.DeletedAt, &s.DeletedBy, &s.DeletedByAdmin,
			&s.CreatedAt,
			&s.Description, &s.BannerURL, &s.Category, &s.Verified, &s.Featured,
		); err != nil {
			return nil, fmt.Errorf("failed to scan expired server: %w", err)
		}
		servers = append(servers, s)
	}
	return servers, rows.Err()
}

// ─── Membership ───

func (r *sqliteServerRepo) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	// Sorted by user's custom position, with joined_at as tiebreaker.
	// Soft-deleted servers excluded — members must not see them.
	query := `
		SELECT s.id, s.name, s.icon_url, s.verified, s.e2ee_enabled
		FROM servers s
		INNER JOIN server_members sm ON s.id = sm.server_id
		WHERE sm.user_id = ? AND s.deleted_at IS NULL
		ORDER BY sm.position ASC, sm.joined_at ASC`

	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user servers: %w", err)
	}
	defer rows.Close()

	var servers []models.ServerListItem
	for rows.Next() {
		var s models.ServerListItem
		if err := rows.Scan(&s.ID, &s.Name, &s.IconURL, &s.Verified, &s.E2EEEnabled); err != nil {
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
	// New member appended at end: position = max + 1 (atomic via subquery).
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
	result, err := r.db.ExecContext(ctx,
		`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`,
		serverID, userID)
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

	// Hard-delete all role assignments for this user in this server.
	// Without this, leftover user_roles let the user pass permission checks
	// (e.g. allowedViewers) and keep receiving broadcasts after leaving.
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM user_roles WHERE user_id = ? AND server_id = ?`,
		userID, serverID); err != nil {
		return fmt.Errorf("failed to clean up user roles on member removal: %w", err)
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

func (r *sqliteServerRepo) GetMemberUserIDs(ctx context.Context, serverID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT user_id FROM server_members WHERE server_id = ?`, serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query server member ids: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan server member id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (r *sqliteServerRepo) UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error {
	sqlDB, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("UpdateMemberPositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

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

// ─── Admin ───

var adminServerSortColumns = map[string]string{
	"name":                "s.name COLLATE NOCASE",
	"owner_username":      "owner_username COLLATE NOCASE",
	"created_at":          "s.created_at",
	"is_platform_managed": "is_platform_managed",
	"member_count":        "member_count",
	"channel_count":       "channel_count",
	"message_count":       "message_count",
	"storage_mb":          "storage_mb",
	"last_activity":       "last_activity",
}

// serverManagedExpr mirrors the is_platform_managed CASE in the data SELECT so the
// managed/self filter can be applied in WHERE (where the SELECT alias isn't visible).
// Both queries LEFT JOIN livekit_instances li, so li.* is in scope for both.
const serverManagedExpr = "CASE WHEN s.livekit_instance_id IS NOT NULL AND li.id IS NULL THEN 1 ELSE COALESCE(li.is_platform_managed, 0) END"

// serverStateClause OR-combines whitelisted deletion states. Constant strings only.
func serverStateClause(statuses []string) string {
	var ors []string
	for _, s := range statuses {
		switch s {
		case "active":
			ors = append(ors, "s.deleted_at IS NULL")
		case "soft_deleted":
			ors = append(ors, "s.deleted_at IS NOT NULL")
		}
	}
	if len(ors) == 0 {
		return ""
	}
	return "(" + strings.Join(ors, " OR ") + ")"
}

// serverTypeClause filters platform-managed vs self-hosted. Both or neither = no filter.
func serverTypeClause(types []string) string {
	wantManaged, wantSelf := false, false
	for _, t := range types {
		switch t {
		case "managed":
			wantManaged = true
		case "self":
			wantSelf = true
		}
	}
	if wantManaged == wantSelf {
		return ""
	}
	if wantManaged {
		return "(" + serverManagedExpr + ") = 1"
	}
	return "(" + serverManagedExpr + ") = 0"
}

// buildAdminServerFilter — WHERE fragment shared by data and count queries.
// Filters combine with AND across dimensions, OR within a dimension.
func buildAdminServerFilter(statuses, types []string, search string) (string, []any) {
	var clauses []string
	var args []any

	if c := serverStateClause(statuses); c != "" {
		clauses = append(clauses, c)
	}
	if c := serverTypeClause(types); c != "" {
		clauses = append(clauses, c)
	}

	if q := strings.TrimSpace(search); q != "" {
		like := "%" + q + "%"
		clauses = append(clauses,
			"(s.name LIKE ? COLLATE NOCASE OR s.id LIKE ? COLLATE NOCASE OR COALESCE(u.username,'') LIKE ? COLLATE NOCASE)")
		args = append(args, like, like, like)
	}

	if len(clauses) == 0 {
		return "", args
	}
	return "WHERE " + strings.Join(clauses, " AND "), args
}

// buildVoiceServerOverlay — same idea as user overlay but keyed by server_id.
func buildVoiceServerOverlay(serverIDs []string) (cte string, override string, args []any) {
	if len(serverIDs) == 0 {
		return "", "", nil
	}
	placeholders := make([]string, len(serverIDs))
	args = make([]any, len(serverIDs))
	for i, id := range serverIDs {
		placeholders[i] = "(?)"
		args[i] = id
	}
	cte = "WITH active_voice_server(server_id) AS (VALUES " + strings.Join(placeholders, ",") + ")"
	override = "(SELECT CASE WHEN EXISTS (SELECT 1 FROM active_voice_server avs WHERE avs.server_id = s.id) THEN datetime('now') ELSE NULL END)"
	return cte, override, args
}

// ListAdminServersPaged — see ServerRepository.ListAdminServersPaged.
func (r *sqliteServerRepo) ListAdminServersPaged(ctx context.Context, params models.AdminListPageParams, activeVoiceServerIDs []string) (models.AdminServerListPage, error) {
	whereSQL, whereArgs := buildAdminServerFilter(params.Statuses, params.Types, params.Search)

	sortExpr, ok := adminServerSortColumns[params.Sort]
	if !ok {
		sortExpr = "s.created_at"
		params.Dir = "desc"
	}
	dir := "ASC"
	if strings.EqualFold(params.Dir, "desc") {
		dir = "DESC"
	}

	countQuery := `
		SELECT COUNT(*)
		FROM servers s
		LEFT JOIN users u ON s.owner_id = u.id
		LEFT JOIN livekit_instances li ON s.livekit_instance_id = li.id
		` + whereSQL
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, whereArgs...).Scan(&total); err != nil {
		return models.AdminServerListPage{}, fmt.Errorf("count admin servers: %w", err)
	}

	voiceCTE, voiceOverrideExpr, voiceArgs := buildVoiceServerOverlay(activeVoiceServerIDs)
	if voiceOverrideExpr == "" {
		voiceOverrideExpr = "NULL"
	}

	dataQuery := voiceCTE + `
		SELECT
			s.id,
			s.name,
			s.icon_url,
			s.owner_id,
			COALESCE(u.username, '') AS owner_username,
			s.created_at,
			CASE
				WHEN s.livekit_instance_id IS NOT NULL AND li.id IS NULL THEN 1
				ELSE COALESCE(li.is_platform_managed, 0)
			END AS is_platform_managed,
			s.livekit_instance_id,
			(SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count,
			(SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
			(SELECT COUNT(*) FROM messages m
			 INNER JOIN channels c2 ON m.channel_id = c2.id
			 WHERE c2.server_id = s.id) AS message_count,
			COALESCE(
				(SELECT SUM(a.file_size) FROM attachments a
				 INNER JOIN messages m2 ON a.message_id = m2.id
				 INNER JOIN channels c3 ON m2.channel_id = c3.id
				 WHERE c3.server_id = s.id), 0
			) / 1048576.0 AS storage_mb,
			MAX(
				COALESCE((SELECT MAX(m3.created_at) FROM messages m3
				 INNER JOIN channels c4 ON m3.channel_id = c4.id
				 WHERE c4.server_id = s.id), ''),
				COALESCE(s.last_voice_activity, ''),
				COALESCE(` + voiceOverrideExpr + `, '')
			) AS last_activity,
			s.verified,
			s.featured,
			s.discovery_blocked,
			s.deleted_at,
			s.deleted_by_admin
		FROM servers s
		LEFT JOIN users u ON s.owner_id = u.id
		LEFT JOIN livekit_instances li ON s.livekit_instance_id = li.id
		` + whereSQL + `
		ORDER BY ` + sortExpr + ` ` + dir + `, s.id ASC
		LIMIT ? OFFSET ?`

	args := append([]any{}, voiceArgs...)
	args = append(args, whereArgs...)
	args = append(args, params.Limit, params.Offset)

	rows, err := r.db.QueryContext(ctx, dataQuery, args...)
	if err != nil {
		return models.AdminServerListPage{}, fmt.Errorf("list admin servers paged: %w", err)
	}
	defer rows.Close()

	items := make([]models.AdminServerListItem, 0, params.Limit)
	for rows.Next() {
		var s models.AdminServerListItem
		if err := rows.Scan(
			&s.ID, &s.Name, &s.IconURL, &s.OwnerID, &s.OwnerUsername,
			&s.CreatedAt, &s.IsPlatformManaged, &s.LiveKitInstanceID,
			&s.MemberCount, &s.ChannelCount, &s.MessageCount,
			&s.StorageMB, &s.LastActivity,
			&s.Verified, &s.Featured, &s.DiscoveryBlocked,
			&s.DeletedAt, &s.DeletedByAdmin,
		); err != nil {
			return models.AdminServerListPage{}, fmt.Errorf("scan admin server row: %w", err)
		}
		items = append(items, s)
	}
	if err := rows.Err(); err != nil {
		return models.AdminServerListPage{}, fmt.Errorf("iterate admin server rows: %w", err)
	}

	return models.AdminServerListPage{Items: items, Total: total}, nil
}

func (r *sqliteServerRepo) UpdateLastVoiceActivity(ctx context.Context, serverID string) error {
	query := `UPDATE servers SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`
	_, err := r.db.ExecContext(ctx, query, serverID)
	if err != nil {
		return fmt.Errorf("failed to update last voice activity: %w", err)
	}
	return nil
}

func (r *sqliteServerRepo) GetMemberServerIDs(ctx context.Context, userID string) ([]string, error) {
	// Soft-deleted servers excluded — members must not be subscribed to them.
	query := `
		SELECT sm.server_id FROM server_members sm
		INNER JOIN servers s ON sm.server_id = s.id
		WHERE sm.user_id = ? AND s.deleted_at IS NULL`

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

func (r *sqliteServerRepo) CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error) {
	query := `
		SELECT COUNT(*) FROM servers s
		JOIN livekit_instances li ON s.livekit_instance_id = li.id
		WHERE s.owner_id = ? AND li.is_platform_managed = true`

	var count int
	if err := r.db.QueryRowContext(ctx, query, ownerID).Scan(&count); err != nil {
		return 0, fmt.Errorf("failed to count owned mqvi-hosted servers: %w", err)
	}
	return count, nil
}
