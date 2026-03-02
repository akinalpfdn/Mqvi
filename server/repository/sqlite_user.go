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

// sqliteUserRepo, UserRepository interface'inin SQLite implementasyonu.
//
// Go'da struct field'ları küçük harfle başlarsa (db) → private (package dışından erişilemez).
// Büyük harfle başlarsa (DB) → public.
// Repository'nin DB bağlantısı dışarıya açık olmamalı — bu yüzden küçük harf.
type sqliteUserRepo struct {
	db database.TxQuerier
}

// NewSQLiteUserRepo, constructor fonksiyonu.
// UserRepository interface'i döner (concrete struct değil) — Dependency Inversion.
//
// Go'da "constructor" diye özel bir syntax yok.
// Konvansiyon: New + tip adı → NewSQLiteUserRepo.
// Interface dönmek, çağıran tarafın implementasyondan bağımsız olmasını sağlar.
func NewSQLiteUserRepo(db database.TxQuerier) UserRepository {
	return &sqliteUserRepo{db: db}
}

func (r *sqliteUserRepo) Create(ctx context.Context, user *models.User) error {
	query := `
		INSERT INTO users (id, username, display_name, avatar_url, password_hash, status, email, language, is_platform_admin)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	// QueryRowContext: tek bir satır dönen sorgu çalıştırır.
	// Scan: sorgu sonucunu Go değişkenlerine aktarır.
	// &user.ID → "user.ID değişkeninin bellek adresini ver" demek (pointer).
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
		// UNIQUE constraint violation → kullanıcı adı veya email zaten var
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status,
			email, language, is_platform_admin, is_platform_banned,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE id = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email,
		&user.Language, &user.IsPlatformAdmin, &user.IsPlatformBanned,
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status,
			email, language, is_platform_admin, is_platform_banned,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE username = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email,
		&user.Language, &user.IsPlatformAdmin, &user.IsPlatformBanned,
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status,
			email, language, is_platform_admin, is_platform_banned,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users ORDER BY username`

	// QueryContext: birden fazla satır dönen sorgu.
	// rows.Next() ile satır satır iterasyon yapılır.
	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to get all users: %w", err)
	}
	defer rows.Close() // Önemli: rows'u kapatmayı ASLA unutma — aksi halde bağlantı sızar (leak)

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(
			&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL,
			&u.PasswordHash, &u.Status, &u.CustomStatus, &u.Email,
			&u.Language, &u.IsPlatformAdmin, &u.IsPlatformBanned,
			&u.PlatformBanReason, &u.PlatformBannedBy, &u.PlatformBannedAt,
			&u.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan user row: %w", err)
		}
		users = append(users, u)
	}

	// rows.Err(): iterasyon sırasında oluşan hataları kontrol et
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating user rows: %w", err)
	}

	return users, nil
}

func (r *sqliteUserRepo) Update(ctx context.Context, user *models.User) error {
	query := `
		UPDATE users SET display_name = ?, avatar_url = ?, custom_status = ?, language = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		user.DisplayName, user.AvatarURL, user.CustomStatus, user.Language, user.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update user: %w", err)
	}

	// RowsAffected: kaç satır etkilendi? 0 ise kullanıcı bulunamadı.
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

// UpdatePassword, kullanıcının şifre hash'ini günceller.
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

// UpdateEmail, kullanıcının email adresini günceller.
// nil → email kaldır (NULL), *string → yeni email set et.
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

// GetByEmail, email adresine göre kullanıcı arar.
// İleride "şifremi unuttum" akışı için kullanılacak.
func (r *sqliteUserRepo) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	query := `
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status,
			email, language, is_platform_admin, is_platform_banned,
			platform_ban_reason, platform_banned_by, platform_banned_at, created_at
		FROM users WHERE email = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email,
		&user.Language, &user.IsPlatformAdmin, &user.IsPlatformBanned,
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

// isUniqueViolation, SQLite UNIQUE constraint hatasını kontrol eder.
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

func (r *sqliteUserRepo) ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error) {
	// Tek sorgu ile tüm kullanıcı istatistiklerini toplayan correlated subquery pattern.
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

// UpdateLastVoiceActivity, kullanıcının son ses aktivitesi zamanını şimdiki zamana günceller.
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

// PlatformBan, kullanıcıyı platform genelinde yasaklar.
// is_platform_banned flag'i 1 yapılır, sebep ve admin bilgisi kaydedilir.
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

// PlatformUnban, platform ban'ini kaldırır.
// Ban bilgileri (reason, banned_by, banned_at) temizlenir.
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

// IsEmailPlatformBanned, verilen email'in banlı bir kullanıcıya ait olup olmadığını kontrol eder.
// Kayıt sırasında aynı email ile yeni hesap açılmasını engellemek için kullanılır.
func (r *sqliteUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	query := `SELECT COUNT(*) FROM users WHERE email = ? AND is_platform_banned = 1`

	var count int
	err := r.db.QueryRowContext(ctx, query, email).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check email platform ban: %w", err)
	}

	return count > 0, nil
}

// DeleteAllMessagesByUser, kullanıcının tüm server mesajlarını ve DM mesajlarını siler.
// Attachment'lar messages tablosuna CASCADE ile silinir.
// Platform ban'de opsiyonel "mesajları da sil" seçeneği için kullanılır.
func (r *sqliteUserRepo) DeleteAllMessagesByUser(ctx context.Context, userID string) error {
	// Server mesajları — attachments tablosu messages'a CASCADE ile bağlı,
	// dolayısıyla mesaj silinince ekler de otomatik silinir.
	_, err := r.db.ExecContext(ctx, `DELETE FROM messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user messages: %w", err)
	}

	// DM mesajları
	_, err = r.db.ExecContext(ctx, `DELETE FROM dm_messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user DM messages: %w", err)
	}

	return nil
}

// HardDeleteUser, kullanıcıyı ve CASCADE ile tüm ilişkili verileri kalıcı olarak siler.
//
// CASCADE ile otomatik silinen tablolar:
// user_roles, messages, sessions, dm_channels, dm_messages,
// message_mentions, reactions, friendships, server_members,
// channel_reads, password_reset_tokens, server_mutes
//
// Manuel temizlik gerektiren tablolar:
// - bans: FK yok, username text olarak saklanır — orphan kalır ama zararsız
// - servers.owner_id: CASCADE yok — çağıran service sahip olunan sunucuları önceden temizlemeli
func (r *sqliteUserRepo) HardDeleteUser(ctx context.Context, userID string) error {
	// Bans tablosunda FK olmadığından manuel temizlik
	_, err := r.db.ExecContext(ctx, `DELETE FROM bans WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to clean up bans for user: %w", err)
	}

	// servers.owner_id → users(id) CASCADE yok.
	// Sahip olunan sunucuları sil — servers tablosunun kendi CASCADE'i
	// channels, roles, messages vb. sunucu verilerini otomatik temizler.
	_, err = r.db.ExecContext(ctx, `DELETE FROM servers WHERE owner_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete owned servers: %w", err)
	}

	// Ana silme — CASCADE ile tüm ilişkili veriler otomatik silinir
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
