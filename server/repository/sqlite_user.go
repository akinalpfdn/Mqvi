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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status, email, language, is_platform_admin, created_at
		FROM users WHERE id = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email, &user.Language, &user.IsPlatformAdmin, &user.CreatedAt,
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status, email, language, is_platform_admin, created_at
		FROM users WHERE username = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email, &user.Language, &user.IsPlatformAdmin, &user.CreatedAt,
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status, email, language, is_platform_admin, created_at
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
			&u.PasswordHash, &u.Status, &u.CustomStatus, &u.Email, &u.Language, &u.IsPlatformAdmin, &u.CreatedAt,
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
		SELECT id, username, display_name, avatar_url, password_hash, status, custom_status, email, language, is_platform_admin, created_at
		FROM users WHERE email = ?`

	user := &models.User{}
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.AvatarURL,
		&user.PasswordHash, &user.Status, &user.CustomStatus, &user.Email, &user.Language, &user.IsPlatformAdmin, &user.CreatedAt,
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
