package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
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
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE id = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
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
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE username = ? COLLATE NOCASE`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
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

func (r *sqliteUserRepo) GetAll(ctx context.Context) ([]models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, wallpaper_url, password_hash, status, pref_status, custom_status,
			email, language, dm_privacy, is_platform_admin, is_platform_banned, has_seen_download_prompt, has_seen_welcome,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
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

func (r *sqliteUserRepo) UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error {
	query := `UPDATE users SET password_hash = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, newPasswordHash, userID)
	if err != nil {
		return fmt.Errorf("failed to update password: %w", err)
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
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE email = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL, &user.WallpaperURL,
		&user.PasswordHash, &user.Status, &user.PrefStatus, &user.CustomStatus, &user.Email,
		&user.Language, &user.DMPrivacy, &user.IsPlatformAdmin, &user.IsPlatformBanned, &user.HasSeenDownloadPrompt, &user.HasSeenWelcome,
		&user.PlatformBanReason, &user.PlatformBannedBy, &user.PlatformBannedAt,
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

// ListAllUsersWithStats returns all users with aggregated stats via correlated subqueries.
func (r *sqliteUserRepo) ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error) {
	query := `
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
			) sub WHERE val IS NOT NULL),
			(SELECT COUNT(*) FROM messages m2 WHERE m2.user_id = u.id),
			COALESCE(
				(SELECT SUM(a.file_size) FROM attachments a
				 INNER JOIN messages m3 ON a.message_id = m3.id
				 WHERE m3.user_id = u.id), 0
			) / 1048576.0,
			(SELECT COUNT(*) FROM servers sv
			 LEFT JOIN livekit_instances li ON sv.livekit_instance_id = li.id
			 WHERE sv.owner_id = u.id AND COALESCE(li.is_platform_managed, 0) = 0),
			(SELECT COUNT(*) FROM servers sv2
			 LEFT JOIN livekit_instances li2 ON sv2.livekit_instance_id = li2.id
			 WHERE sv2.owner_id = u.id AND COALESCE(li2.is_platform_managed, 0) = 1),
			(SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id),
			(SELECT COUNT(*) FROM bans b WHERE b.user_id = u.id)
		FROM users u
		ORDER BY u.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list all users with stats: %w", err)
	}
	defer rows.Close()

	var users []models.AdminUserListItem
	for rows.Next() {
		var u models.AdminUserListItem
		if err := rows.Scan(
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL,
			&u.IsPlatformAdmin, &u.IsPlatformBanned, &u.CreatedAt, &u.Status,
			&u.LastActivity, &u.MessageCount, &u.StorageMB,
			&u.OwnedSelfServers, &u.OwnedMqviServers,
			&u.MemberServerCount, &u.BanCount,
		); err != nil {
			return nil, fmt.Errorf("failed to scan admin user row: %w", err)
		}
		users = append(users, u)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating admin user rows: %w", err)
	}

	return users, nil
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

// IsEmailPlatformBanned checks if the email belongs to a banned user.
// Used during registration to prevent new accounts with banned emails.
func (r *sqliteUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	query := `SELECT COUNT(*) FROM users WHERE email = ? AND is_platform_banned = 1`

	var count int
	err := r.db.QueryRowContext(ctx, query, email).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check email platform ban: %w", err)
	}

	return count > 0, nil
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

// HardDeleteUser permanently deletes the user and all CASCADE-linked data.
//
// CASCADE covers: user_roles, messages, sessions, dm_channels, dm_messages,
// message_mentions, reactions, friendships, server_members, channel_reads,
// password_reset_tokens, server_mutes.
//
// Manual cleanup needed:
// - bans: no FK, username stored as text — orphans are harmless
// - servers.owner_id: no CASCADE — caller must clean up owned servers first
func (r *sqliteUserRepo) HardDeleteUser(ctx context.Context, userID string) error {
	// bans has no FK — manual cleanup
	_, err := r.db.ExecContext(ctx, `DELETE FROM bans WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to clean up bans for user: %w", err)
	}

	// servers.owner_id has no CASCADE — delete owned servers first
	_, err = r.db.ExecContext(ctx, `DELETE FROM servers WHERE owner_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete owned servers: %w", err)
	}

	// Main delete — CASCADE handles all related data
	result, err := r.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to hard delete user: %w", err)
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
