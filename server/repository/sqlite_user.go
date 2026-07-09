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
	"github.com/google/uuid"
)

type sqliteUserRepo struct {
	db database.TxQuerier
}

func NewSQLiteUserRepo(db database.TxQuerier) UserRepository {
	return &sqliteUserRepo{db: db}
}

func (r *sqliteUserRepo) Create(ctx context.Context, user *models.User) error {
	query := `
		INSERT INTO users (id, username, display_name, avatar_url, password_hash, status, email, language, is_platform_admin)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		user.Username,
		user.DisplayName,
		user.AvatarURL,
		user.PasswordHash,
		user.Status,
		user.Email,
		user.Language,
		user.IsPlatformAdmin,
	).Scan(&user.ID, &user.CreatedAt)

	if err != nil {
		if isUniqueViolation(err) {
			if containsString(err.Error(), "idx_users_email") {
				return fmt.Errorf("%w: email already in use", pkg.ErrAlreadyExists)
			}
			return fmt.Errorf("%w: username already taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to create user: %w", err)
	}

	return nil
}

func (r *sqliteUserRepo) GetByID(ctx context.Context, id string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users WHERE id = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
		&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
		&user.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by id: %w", err)
	}

	return user, nil
}

func (r *sqliteUserRepo) GetByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users WHERE username = ? COLLATE NOCASE`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
		&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
		&user.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by username: %w", err)
	}

	return user, nil
}

// GetActiveByID returns the user only if not soft-deleted/tombstone.
// Used for auth paths where deleted users must be invisible.
func (r *sqliteUserRepo) GetActiveByID(ctx context.Context, id string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users WHERE id = ? AND deleted_at IS NULL`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
		&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
		&user.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get active user by id: %w", err)
	}
	return user, nil
}

// GetActiveByUsername returns the user only if not soft-deleted/tombstone.
func (r *sqliteUserRepo) GetActiveByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
		&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
		&user.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get active user by username: %w", err)
	}
	return user, nil
}

func (r *sqliteUserRepo) GetAll(ctx context.Context) ([]models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users ORDER BY username`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var user models.User
		if err := rows.Scan(
			&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
			&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
			&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
			&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
			&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
			&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
			&user.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan user row: %w", err)
		}
		users = append(users, user)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating user rows: %w", err)
	}

	return users, nil
}

func (r *sqliteUserRepo) Update(ctx context.Context, user *models.User) error {
	query := `
		UPDATE users SET username = ?, display_name = ?, avatar_url = ?, custom_status = ?, language = ?, dm_privacy = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		user.Username, user.DisplayName, user.AvatarURL, user.CustomStatus, user.Language, user.DMPrivacy, user.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update user: %w", err)
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

func (r *sqliteUserRepo) UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error {
	query := `UPDATE users SET status = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, status, userID)
	if err != nil {
		return fmt.Errorf("failed to update user status: %w", err)
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

func (r *sqliteUserRepo) UpdatePrefStatus(ctx context.Context, userID string, prefStatus models.UserStatus) error {
	query := `UPDATE users SET pref_status = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, prefStatus, userID)
	if err != nil {
		return fmt.Errorf("failed to update user pref_status: %w", err)
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

func (r *sqliteUserRepo) UpdatePassword(ctx context.Context, userID, oldPasswordHash, newPasswordHash string) (int, error) {
	if tx, ok := r.db.(*sql.Tx); ok {
		return r.updatePasswordTx(ctx, tx, userID, oldPasswordHash, newPasswordHash)
	}
	db, ok := r.db.(*sql.DB)
	if !ok {
		return 0, fmt.Errorf("UpdatePassword requires *sql.DB or *sql.Tx")
	}
	var newTV int
	err := database.WithTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		newTV, err = r.updatePasswordTx(ctx, tx, userID, oldPasswordHash, newPasswordHash)
		return err
	})
	return newTV, err
}

func (r *sqliteUserRepo) ResetPasswordWithToken(ctx context.Context, userID, resetTokenID, newPasswordHash string) (int, error) {
	if tx, ok := r.db.(*sql.Tx); ok {
		return r.resetPasswordWithTokenTx(ctx, tx, userID, resetTokenID, newPasswordHash)
	}
	db, ok := r.db.(*sql.DB)
	if !ok {
		return 0, fmt.Errorf("ResetPasswordWithToken requires *sql.DB or *sql.Tx")
	}
	var newTV int
	err := database.WithTx(ctx, db, func(tx *sql.Tx) error {
		var err error
		newTV, err = r.resetPasswordWithTokenTx(ctx, tx, userID, resetTokenID, newPasswordHash)
		return err
	})
	return newTV, err
}

func (r *sqliteUserRepo) resetPasswordWithTokenTx(ctx context.Context, tx *sql.Tx, userID, resetTokenID, newPasswordHash string) (int, error) {
	res, err := tx.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE id = ? AND user_id = ? AND expires_at >= CURRENT_TIMESTAMP`, resetTokenID, userID)
	if err != nil {
		return 0, fmt.Errorf("consume reset token: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("consume reset token rows affected: %w", err)
	}
	if affected == 0 {
		return 0, pkg.ErrNotFound
	}
	newTV, err := r.updatePasswordTx(ctx, tx, userID, "", newPasswordHash)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE user_id = ?`, userID); err != nil {
		return 0, fmt.Errorf("clear reset tokens: %w", err)
	}
	return newTV, nil
}

func (r *sqliteUserRepo) updatePasswordTx(ctx context.Context, tx *sql.Tx, userID, oldPasswordHash, newPasswordHash string) (int, error) {
	var (
		newTV int
		row   *sql.Row
	)
	if oldPasswordHash == "" {
		row = tx.QueryRowContext(ctx,
			`UPDATE users SET password_hash = ?, token_version = token_version + 1
			 WHERE id = ?
			 RETURNING token_version`,
			newPasswordHash, userID,
		)
	} else {
		row = tx.QueryRowContext(ctx,
			`UPDATE users SET password_hash = ?, token_version = token_version + 1
			 WHERE id = ? AND password_hash = ?
			 RETURNING token_version`,
			newPasswordHash, userID, oldPasswordHash,
		)
	}
	err := row.Scan(&newTV)
	if errors.Is(err, sql.ErrNoRows) {
		if oldPasswordHash != "" {
			return 0, pkg.ErrConflict
		}
		return 0, pkg.ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("update password: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
		return 0, fmt.Errorf("revoke sessions: %w", err)
	}
	return newTV, nil
}

// UpdateEmail updates the user's email. nil removes it (NULL), *string sets a new one.
func (r *sqliteUserRepo) UpdateEmail(ctx context.Context, userID string, email *string) error {
	query := `UPDATE users SET email = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, email, userID)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: email already in use", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to update email: %w", err)
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

func (r *sqliteUserRepo) UpdateWallpaper(ctx context.Context, userID string, wallpaperURL *string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE users SET wallpaper_url = ? WHERE id = ?`, wallpaperURL, userID)
	if err != nil {
		return fmt.Errorf("failed to update wallpaper: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users WHERE email = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
		&user.DeletedAt, &user.DeletedByAdmin, &user.IsHardDeleted, &user.TokenVersion,
		&user.FeedbackLastSeenAt, &user.ReportsLastSeenAt,
		&user.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get user by email: %w", err)
	}

	return user, nil
}

func (r *sqliteUserRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count users: %w", err)
	}
	return count, nil
}

func (r *sqliteUserRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM users WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
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

func isUniqueViolation(err error) bool {
	return err != nil && (errors.Is(err, sql.ErrNoRows) == false) &&
		(containsString(err.Error(), "UNIQUE constraint failed"))
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// ─── Admin ───

// buildVoiceUserOverlay returns CTE + UNION fragment + args used to inject
// "now" as last_voice_activity for currently-in-voice users. Empty slice → empty
// strings (no CTE, no override).
func buildVoiceUserOverlay(userIDs []string) (cte string, union string, args []any) {
	if len(userIDs) == 0 {
		return "", "", nil
	}
	placeholders := make([]string, len(userIDs))
	args = make([]any, len(userIDs))
	for i, id := range userIDs {
		placeholders[i] = "(?)"
		args[i] = id
	}
	cte = "WITH active_voice(user_id) AS (VALUES " + strings.Join(placeholders, ",") + ")"
	union = "UNION ALL SELECT CASE WHEN EXISTS (SELECT 1 FROM active_voice av WHERE av.user_id = u.id) THEN datetime('now') END"
	return cte, union, args
}

// adminUserSortColumns maps validated sort keys to SQL expressions. Anything not
// in this map falls back to created_at DESC. Tie-breaker u.id is always appended.
var adminUserSortColumns = map[string]string{
	"username":            "u.username COLLATE NOCASE",
	"display_name":        "COALESCE(u.display_name, '') COLLATE NOCASE",
	"created_at":          "u.created_at",
	"status":              "u.status",
	"is_platform_admin":   "u.is_platform_admin",
	"last_activity":       "last_activity",
	"message_count":       "message_count",
	"storage_mb":          "storage_mb",
	"quota_bytes":         "quota_bytes",
	"owned_self_servers":  "owned_self_servers",
	"owned_mqvi_servers":  "owned_mqvi_servers",
	"member_server_count": "member_server_count",
	"ban_count":           "ban_count",
}

// userStateClause OR-combines the whitelisted deletion/account states into a single
// parenthesized condition. All fragments are constant strings — no caller input.
func userStateClause(statuses []string) string {
	var ors []string
	for _, s := range statuses {
		switch s {
		case "active":
			ors = append(ors, "(u.is_platform_banned = 0 AND u.deleted_at IS NULL)")
		case "banned":
			ors = append(ors, "u.is_platform_banned = 1")
		case "soft_deleted":
			ors = append(ors, "(u.deleted_at IS NOT NULL AND u.is_hard_deleted = 0)")
		case "tombstone":
			ors = append(ors, "u.is_hard_deleted = 1")
		}
	}
	if len(ors) == 0 {
		return ""
	}
	return "(" + strings.Join(ors, " OR ") + ")"
}

// userAdminClause filters on the platform-admin flag. Both sides or neither selected
// means "no filter".
func userAdminClause(admin []string) string {
	wantAdmin, wantNon := false, false
	for _, a := range admin {
		switch a {
		case "admin":
			wantAdmin = true
		case "non_admin":
			wantNon = true
		}
	}
	if wantAdmin == wantNon {
		return ""
	}
	if wantAdmin {
		return "u.is_platform_admin = 1"
	}
	return "u.is_platform_admin = 0"
}

// buildAdminUserFilter — produces the WHERE fragment and arg list shared by the data
// and count queries. All filter values are whitelisted by the handler; search applies
// to username/id/display_name. Filters combine with AND across dimensions, OR within.
func buildAdminUserFilter(statuses, presences, admin []string, search string) (string, []any) {
	var clauses []string
	var args []any

	if c := userStateClause(statuses); c != "" {
		clauses = append(clauses, c)
	}
	if len(presences) > 0 {
		clauses = append(clauses, "u.status IN ("+sqlPlaceholders(len(presences))+")")
		for _, p := range presences {
			args = append(args, p)
		}
	}
	if c := userAdminClause(admin); c != "" {
		clauses = append(clauses, c)
	}

	if s := strings.TrimSpace(search); s != "" {
		like := "%" + s + "%"
		clauses = append(clauses,
			"(u.username LIKE ? COLLATE NOCASE OR u.id LIKE ? COLLATE NOCASE OR COALESCE(u.display_name,'') LIKE ? COLLATE NOCASE)")
		args = append(args, like, like, like)
	}

	if len(clauses) == 0 {
		return "", args
	}
	return "WHERE " + strings.Join(clauses, " AND "), args
}

// ListAdminUsersPaged — see UserRepository.ListAdminUsersPaged.
func (r *sqliteUserRepo) ListAdminUsersPaged(ctx context.Context, params models.AdminListPageParams, defaultQuotaBytes int64, activeVoiceUserIDs []string) (models.AdminUserListPage, error) {
	whereSQL, whereArgs := buildAdminUserFilter(params.Statuses, params.Presences, params.Admin, params.Search)

	sortExpr, ok := adminUserSortColumns[params.Sort]
	if !ok {
		sortExpr = "u.created_at"
		params.Dir = "desc"
	}
	dir := "ASC"
	if strings.EqualFold(params.Dir, "desc") {
		dir = "DESC"
	}

	// Count first — same WHERE, no LIMIT.
	countQuery := "SELECT COUNT(*) FROM users u " + whereSQL
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, whereArgs...).Scan(&total); err != nil {
		return models.AdminUserListPage{}, fmt.Errorf("count admin users: %w", err)
	}

	// Voice override CTE: feeds last_voice_activity = "now" into the last_activity
	// subquery for users currently in voice (DB last_voice_activity only stamps at
	// JOIN time). Without this, last_activity sort would mis-order long-running voice
	// sessions across page boundaries.
	voiceCTE, voiceUnion, voiceArgs := buildVoiceUserOverlay(activeVoiceUserIDs)

	dataQuery := voiceCTE + `
		SELECT
			u.id,
			u.username,
			u.display_name,
			u.avatar_url,
			u.is_platform_admin,
			u.is_platform_banned,
			u.created_at,
			u.status,
			(SELECT MAX(val) FROM (
				SELECT MAX(m.created_at) AS val FROM messages m WHERE m.user_id = u.id
				UNION ALL
				SELECT u.last_voice_activity
				` + voiceUnion + `
			) sub WHERE val IS NOT NULL) AS last_activity,
			(SELECT COUNT(*) FROM messages m2 WHERE m2.user_id = u.id) AS message_count,
			COALESCE((SELECT us.bytes_used FROM user_storage us WHERE us.user_id = u.id), 0) / 1048576.0 AS storage_mb,
			COALESCE((SELECT us.quota_bytes FROM user_storage us WHERE us.user_id = u.id), ?) AS quota_bytes,
			(SELECT COUNT(*) FROM servers sv
			 LEFT JOIN livekit_instances li ON sv.livekit_instance_id = li.id
			 WHERE sv.owner_id = u.id AND COALESCE(li.is_platform_managed, 0) = 0) AS owned_self_servers,
			(SELECT COUNT(*) FROM servers sv2
			 LEFT JOIN livekit_instances li2 ON sv2.livekit_instance_id = li2.id
			 WHERE sv2.owner_id = u.id AND COALESCE(li2.is_platform_managed, 0) = 1) AS owned_mqvi_servers,
			(SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id) AS member_server_count,
			(SELECT COUNT(*) FROM bans b WHERE b.user_id = u.id) AS ban_count,
			u.deleted_at,
			u.deleted_by_admin,
			u.is_hard_deleted
		FROM users u
		` + whereSQL + `
		ORDER BY ` + sortExpr + ` ` + dir + `, u.id ASC
		LIMIT ? OFFSET ?`

	args := append([]any{}, voiceArgs...)
	args = append(args, defaultQuotaBytes)
	args = append(args, whereArgs...)
	args = append(args, params.Limit, params.Offset)

	rows, err := r.db.QueryContext(ctx, dataQuery, args...)
	if err != nil {
		return models.AdminUserListPage{}, fmt.Errorf("list admin users paged: %w", err)
	}
	defer rows.Close()

	items := make([]models.AdminUserListItem, 0, params.Limit)
	for rows.Next() {
		var u models.AdminUserListItem
		if err := rows.Scan(
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL,
			&u.IsPlatformAdmin, &u.IsPlatformBanned, &u.CreatedAt, &u.Status,
			&u.LastActivity, &u.MessageCount, &u.StorageMB, &u.QuotaBytes,
			&u.OwnedSelfServers, &u.OwnedMqviServers,
			&u.MemberServerCount, &u.BanCount,
			&u.DeletedAt, &u.DeletedByAdmin, &u.IsHardDeleted,
		); err != nil {
			return models.AdminUserListPage{}, fmt.Errorf("scan admin user row: %w", err)
		}
		items = append(items, u)
	}
	if err := rows.Err(); err != nil {
		return models.AdminUserListPage{}, fmt.Errorf("iterate admin user rows: %w", err)
	}

	return models.AdminUserListPage{Items: items, Total: total}, nil
}

func (r *sqliteUserRepo) UpdateLastVoiceActivity(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE users SET last_voice_activity = CURRENT_TIMESTAMP WHERE id = ?`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to update user voice activity: %w", err)
	}
	return nil
}

// ─── Platform Ban ───

func (r *sqliteUserRepo) PlatformBan(ctx context.Context, userID, reason, bannedBy string) error {
	query := `
		UPDATE users
		SET is_platform_banned = 1,
			platform_ban_reason = ?,
			platform_banned_by = ?,
			platform_banned_at = CURRENT_TIMESTAMP
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, reason, bannedBy, userID)
	if err != nil {
		return fmt.Errorf("failed to platform ban user: %w", err)
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

func (r *sqliteUserRepo) PlatformUnban(ctx context.Context, userID string) error {
	query := `
		UPDATE users
		SET is_platform_banned = 0,
			platform_ban_reason = '',
			platform_banned_by = '',
			platform_banned_at = NULL
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, userID)
	if err != nil {
		return fmt.Errorf("failed to platform unban user: %w", err)
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

// IsEmailPlatformBanned checks the platform_bans table for a banned email.
// Persists even after user hard-delete.
func (r *sqliteUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM platform_bans WHERE email = ? COLLATE NOCASE`, email).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check email platform ban: %w", err)
	}
	return count > 0, nil
}

func (r *sqliteUserRepo) IsUsernamePlatformBanned(ctx context.Context, username string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM platform_bans WHERE username = ? COLLATE NOCASE`, username).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check username platform ban: %w", err)
	}
	return count > 0, nil
}

func (r *sqliteUserRepo) IsPlatformBannedByUserID(ctx context.Context, userID string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM platform_bans WHERE user_id = ?`, userID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check platform ban by user ID: %w", err)
	}
	return count > 0, nil
}

func (r *sqliteUserRepo) InsertPlatformBan(ctx context.Context, email, username, userID, reason, bannedBy string) error {
	id := uuid.New().String()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO platform_bans (id, email, username, user_id, reason, banned_by) VALUES (?, ?, ?, ?, ?, ?)`,
		id, email, username, userID, reason, bannedBy,
	)
	if err != nil {
		return fmt.Errorf("failed to insert platform ban: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) DeletePlatformBan(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM platform_bans WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete platform ban: %w", err)
	}
	return nil
}

// DeleteAllMessagesByUser deletes all server messages and DM messages for a user.
// Attachments are CASCADE-deleted with messages. Used for optional "delete messages" on platform ban.
func (r *sqliteUserRepo) DeleteAllMessagesByUser(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user messages: %w", err)
	}

	_, err = r.db.ExecContext(ctx, `DELETE FROM dm_messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user DM messages: %w", err)
	}

	return nil
}

// HardDeleteUser anonymizes the user (tombstone): username renamed to deleted_<id>,
// personal data wiped, password cleared, all relationships removed. The users row
// itself is NOT deleted — messages.user_id, dm_messages.user_id, and similar refs
// keep referential integrity so historical messages survive as "[deleted user]".
//
// Runs in a transaction so partial deletes cannot occur.
//
// Tables manually deleted (would have CASCADEd if user row was deleted):
//   user_roles, sessions, channel_reads, message_mentions, reactions, dm_reactions,
//   friendships, server_members, password_reset_tokens, server_mutes, channel_mutes,
//   e2ee_devices, e2ee_sessions_backup, e2ee_backups, user_badges, user_preferences,
//   soundboard, user_storage.
//
// Tables NOT deleted (tombstone-preserved via the user row):
//   messages, dm_messages, dm_channels, pinned_messages, attachments — caller
//   sees "[deleted user]" via deleted_at flag in JSON response.
//
// Tables manually deleted (non-CASCADE FK or no FK):
//   bans, servers (owned, full cascade including channels/messages/etc),
//   reports, feedback_tickets, feedback_replies, user_dm_settings.
//
// platform_bans is NOT deleted — durable ban survives hard delete.
func (r *sqliteUserRepo) HardDeleteUser(ctx context.Context, userID string, byAdmin bool) error {
	db, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("hard delete requires *sql.DB (got nested tx)")
	}

	byAdminInt := 0
	if byAdmin {
		byAdminInt = 1
	}

	return database.WithTx(ctx, db, func(tx *sql.Tx) error {
		// ─── Manual cleanup of CASCADE-on-user tables (CASCADE won't fire — user row stays) ───
		// Table names verified against migrations 001-060.
		// device_one_time_prekeys cascades via user_devices composite FK; soundboard_attachments
		// cascade via messages on the FK we leave intact (messages stay tombstoned).
		manualCascadeDeletes := []string{
			`DELETE FROM user_roles WHERE user_id = ?`,
			`DELETE FROM sessions WHERE user_id = ?`,
			`DELETE FROM channel_reads WHERE user_id = ?`,
			`DELETE FROM message_mentions WHERE user_id = ?`,
			`DELETE FROM reactions WHERE user_id = ?`,
			`DELETE FROM dm_reactions WHERE user_id = ?`,
			`DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`,
			`DELETE FROM server_members WHERE user_id = ?`,
			`DELETE FROM password_reset_tokens WHERE user_id = ?`,
			`DELETE FROM server_mutes WHERE user_id = ?`,
			`DELETE FROM channel_mutes WHERE user_id = ?`,
			`DELETE FROM user_devices WHERE user_id = ?`,
			`DELETE FROM channel_group_sessions WHERE sender_user_id = ?`,
			`DELETE FROM e2ee_key_backups WHERE user_id = ?`,
			`DELETE FROM user_badges WHERE user_id = ?`,
			`DELETE FROM user_preferences WHERE user_id = ?`,
			`DELETE FROM soundboard_sounds WHERE uploaded_by = ?`,
			`DELETE FROM user_storage WHERE user_id = ?`,
		}
		for _, q := range manualCascadeDeletes {
			args := []any{userID}
			// friendships needs userID twice (user_id OR friend_id)
			if q == `DELETE FROM friendships WHERE user_id = ? OR friend_id = ?` {
				args = append(args, userID)
			}
			if _, err := tx.ExecContext(ctx, q, args...); err != nil {
				return fmt.Errorf("failed cleanup query %q: %w", q, err)
			}
		}

		// ─── Manually replicate ON DELETE behavior for tables that reference users.id ───
		// User row is preserved (tombstone), so CASCADE/SET NULL never fires on its own.
		// We replicate the semantics manually so a hard-deleted user leaves no audit
		// trail (deleted_<id> references) on their non-message relationships.
		//
		// CASCADE → DELETE (pin record only — the pinned message itself stays)
		if _, err := tx.ExecContext(ctx, `DELETE FROM pinned_messages WHERE pinned_by = ?`, userID); err != nil {
			return fmt.Errorf("failed to delete user pinned_messages: %w", err)
		}
		// SET NULL on invites/created_by, badges/created_by, user_badges/assigned_by, servers/deleted_by
		setNullUpdates := []string{
			`UPDATE invites SET created_by = NULL WHERE created_by = ?`,
			`UPDATE badges SET created_by = NULL WHERE created_by = ?`,
			`UPDATE user_badges SET assigned_by = NULL WHERE assigned_by = ?`,
			`UPDATE servers SET deleted_by = NULL WHERE deleted_by = ?`,
		}
		for _, q := range setNullUpdates {
			if _, err := tx.ExecContext(ctx, q, userID); err != nil {
				return fmt.Errorf("failed setnull query %q: %w", q, err)
			}
		}

		// ─── Manual cleanup of non-CASCADE FK tables ───
		if _, err := tx.ExecContext(ctx, `DELETE FROM bans WHERE user_id = ?`, userID); err != nil {
			return fmt.Errorf("failed to clean up bans: %w", err)
		}
		// Owned servers: hard-delete cascades channels/messages/etc.
		if _, err := tx.ExecContext(ctx, `DELETE FROM servers WHERE owner_id = ?`, userID); err != nil {
			return fmt.Errorf("failed to delete owned servers: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM reports WHERE reporter_id = ? OR reported_user_id = ?`, userID, userID); err != nil {
			return fmt.Errorf("failed to delete user reports: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?`, userID); err != nil {
			return fmt.Errorf("failed to clear report resolved_by: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM feedback_replies WHERE user_id = ?`, userID); err != nil {
			return fmt.Errorf("failed to delete user feedback replies: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM feedback_tickets WHERE user_id = ?`, userID); err != nil {
			return fmt.Errorf("failed to delete user feedback tickets: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_dm_settings WHERE user_id = ?`, userID); err != nil {
			return fmt.Errorf("failed to delete user dm settings: %w", err)
		}

		// ─── Anonymize the user row (tombstone) ───
		// Username renamed to deleted_<id> so original is freed for re-registration.
		// Email/password cleared so user cannot log in. Personal data wiped.
		// is_platform_banned + platform ban fields preserved if applicable (separate flow).
		result, err := tx.ExecContext(ctx, `
			UPDATE users SET
				username = 'deleted_' || id,
				email = NULL,
				display_name = NULL,
				avatar_url = NULL,
				wallpaper_url = NULL,
				custom_status = NULL,
				password_hash = '',
				status = 'offline',
				pref_status = 'offline',
				language = 'en',
				dm_privacy = 'everyone',
				is_platform_admin = 0,
				has_seen_download_prompt = 0,
				has_seen_welcome = 0,
				deleted_at = CURRENT_TIMESTAMP,
				deleted_by_admin = ?,
				is_hard_deleted = 1,
				token_version = token_version + 1
			WHERE id = ?`,
			byAdminInt, userID,
		)
		if err != nil {
			return fmt.Errorf("failed to anonymize user (tombstone): %w", err)
		}

		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected: %w", err)
		}
		if affected == 0 {
			return pkg.ErrNotFound
		}

		// ─── Post-condition: dynamic FK residual-reference check ───
		// Enumerate all FKs pointing to users(id) via sqlite_master + pragma_foreign_key_list,
		// then verify no non-allowlisted (table, column) still references this user. If a future
		// migration adds a new FK to users without updating cleanup logic above, this check
		// rolls back the tx instead of leaving silent orphan refs.
		if err := assertNoResidualUserRefs(ctx, tx, userID); err != nil {
			return err
		}

		return nil
	})
}

// allowedTombstoneUserRefs lists (table.column) FKs to users(id) that are INTENTIONALLY
// preserved after HardDeleteUser. Adding a new entry here is a deliberate design choice
// (tombstone-visible authorship, durable platform ban audit, etc) — every other FK to
// users(id) MUST be cleaned up inside the HardDeleteUser tx.
var allowedTombstoneUserRefs = map[string]struct{}{
	// Author tombstones — historical message visibility ("[deleted user]").
	"messages.user_id":     {},
	"dm_messages.user_id":  {},
	"dm_channels.user1_id": {},
	"dm_channels.user2_id": {},
	// Durable platform ban — survives hard delete by design (user_repository.go docstring).
	// platform_bans currently has NO foreign keys (migration 060: user_id and banned_by are
	// plain TEXT columns), so these entries are inert today. Listed as forward-looking
	// insurance: if a future migration converts user_id or banned_by to FK REFERENCES users(id),
	// the residual check must continue to allow them — otherwise hard-delete would wipe
	// the ban audit trail this table exists to preserve.
	"platform_bans.user_id":   {},
	"platform_bans.banned_by": {},
}

// assertNoResidualUserRefs runs inside the HardDeleteUser tx. It enumerates every FK
// to users(id) currently in the schema and verifies that no row outside the
// allowedTombstoneUserRefs set still references userID. Failure rolls back the tx.
func assertNoResidualUserRefs(ctx context.Context, tx *sql.Tx, userID string) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT m.name, fk."from"
		FROM sqlite_master m, pragma_foreign_key_list(m.name) fk
		WHERE m.type = 'table' AND fk."table" = 'users'`)
	if err != nil {
		return fmt.Errorf("FK enumeration failed: %w", err)
	}
	defer rows.Close()

	type fkRef struct {
		table  string
		column string
	}
	var refs []fkRef
	for rows.Next() {
		var r fkRef
		if err := rows.Scan(&r.table, &r.column); err != nil {
			return fmt.Errorf("FK scan: %w", err)
		}
		refs = append(refs, r)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("FK iteration: %w", err)
	}

	for _, r := range refs {
		key := r.table + "." + r.column
		if _, ok := allowedTombstoneUserRefs[key]; ok {
			continue
		}
		// %q quotes identifiers; values from sqlite_master are trustworthy schema names.
		q := fmt.Sprintf(`SELECT COUNT(*) FROM %q WHERE %q = ?`, r.table, r.column)
		var count int
		if err := tx.QueryRowContext(ctx, q, userID).Scan(&count); err != nil {
			return fmt.Errorf("residual ref check %s: %w", key, err)
		}
		if count > 0 {
			return fmt.Errorf(
				"hard delete left %d residual reference(s) in %s for user %s — "+
					"either add cleanup to HardDeleteUser or, if intentional, "+
					"add %q to allowedTombstoneUserRefs",
				count, key, userID, key,
			)
		}
	}
	return nil
}

// SoftDelete marks the user soft-deleted (recoverable for 30 days).
// User row is preserved with deleted_at set; login flow detects this and offers recovery.
func (r *sqliteUserRepo) SoftDelete(ctx context.Context, userID string, byAdmin bool) error {
	byAdminInt := 0
	if byAdmin {
		byAdminInt = 1
	}
	result, err := r.db.ExecContext(ctx,
		`UPDATE users SET deleted_at = CURRENT_TIMESTAMP, deleted_by_admin = ?, is_hard_deleted = 0
		 WHERE id = ? AND deleted_at IS NULL`,
		byAdminInt, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to soft delete user: %w", err)
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

// Restore clears soft-delete fields. Returns ErrNotFound if user is not soft-deleted
// or is a tombstone (is_hard_deleted=1). Caller is responsible for password verification.
func (r *sqliteUserRepo) Restore(ctx context.Context, userID string) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE users SET deleted_at = NULL, deleted_by_admin = 0
		 WHERE id = ? AND deleted_at IS NOT NULL AND is_hard_deleted = 0`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to restore user: %w", err)
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

// ListSoftDeletedExpired returns soft-deleted users (not yet tombstone) past TTL.
// Used by cleanup worker to identify users ready for tombstone hard-delete.
func (r *sqliteUserRepo) ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at,
			deleted_at, deleted_by_admin, is_hard_deleted, token_version, feedback_last_seen_at, reports_last_seen_at, created_at
		FROM users
		WHERE deleted_at IS NOT NULL
		  AND is_hard_deleted = 0
		  AND deleted_at < datetime('now', ?)
		ORDER BY deleted_at ASC`
	rows, err := r.db.QueryContext(ctx, query, fmt.Sprintf("-%d days", ttlDays))
	if err != nil {
		return nil, fmt.Errorf("failed to list expired soft-deleted users: %w", err)
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &u.WallpaperURL,
			&u.PasswordHash, &u.Status, &u.PrefStatus, &u.CustomStatus, &u.Email,
			&u.Language, &u.DMPrivacy, &u.IsPlatformAdmin, &u.IsPlatformBanned, &u.HasSeenDownloadPrompt, &u.HasSeenWelcome,
			&u.PlatformBanReason, &u.PlatformBannedBy, &u.PlatformBannedAt,
			&u.DeletedAt, &u.DeletedByAdmin, &u.IsHardDeleted, &u.TokenVersion,
			&u.FeedbackLastSeenAt, &u.ReportsLastSeenAt,
			&u.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan expired user: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (r *sqliteUserRepo) SetDownloadPromptSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET has_seen_download_prompt = 1 WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set download prompt seen: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) SetWelcomeSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET has_seen_welcome = 1 WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set welcome seen: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) MarkFeedbackSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET feedback_last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to mark feedback seen: %w", err)
	}
	return nil
}

func (r *sqliteUserRepo) MarkReportsSeen(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE users SET reports_last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to mark reports seen: %w", err)
	}
	return nil
}

// ListPlatformAdminEmails returns the active platform admins that have an
// email address set. Used for admin-only notification emails.
func (r *sqliteUserRepo) ListPlatformAdminEmails(ctx context.Context) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT email FROM users
		 WHERE is_platform_admin = 1 AND deleted_at IS NULL AND email IS NOT NULL AND email != ''`,
	)
	if err != nil {
		return nil, fmt.Errorf("list platform admin emails: %w", err)
	}
	defer rows.Close()
	var emails []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, fmt.Errorf("scan admin email: %w", err)
		}
		emails = append(emails, e)
	}
	return emails, rows.Err()
}

func (r *sqliteUserRepo) SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE users SET is_platform_admin = ? WHERE id = ?",
		isAdmin, userID,
	)
	if err != nil {
		return fmt.Errorf("failed to set platform admin: %w", err)
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
