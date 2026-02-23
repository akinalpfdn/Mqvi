// Package repository — FriendshipRepository SQLite implementasyonu.
//
// Arkadaşlık tablosu tek yönlü kayıt tutar (user_id → friend_id).
// Accepted arkadaşlar için çift yönlü UNION sorgusu kullanılır.
//
// LEFT JOIN ile kullanıcı bilgileri (username, display_name, avatar, status)
// eklenip FriendshipWithUser DTO'su oluşturulur.
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteFriendshipRepo, FriendshipRepository'nin SQLite implementasyonu.
// Private struct — dışarıdan sadece interface üzerinden erişilir.
type sqliteFriendshipRepo struct {
	db *sql.DB
}

// NewSQLiteFriendshipRepo, constructor. Dependency injection ile DB bağlantısı alır.
func NewSQLiteFriendshipRepo(db *sql.DB) FriendshipRepository {
	return &sqliteFriendshipRepo{db: db}
}

// Create, yeni bir arkadaşlık kaydı oluşturur.
func (r *sqliteFriendshipRepo) Create(ctx context.Context, f *models.Friendship) error {
	query := `INSERT INTO friendships (id, user_id, friend_id, status, created_at, updated_at)
	          VALUES (?, ?, ?, ?, ?, ?)`

	_, err := r.db.ExecContext(ctx, query, f.ID, f.UserID, f.FriendID, f.Status, f.CreatedAt, f.UpdatedAt)
	if err != nil {
		return fmt.Errorf("friendship create: %w", err)
	}
	return nil
}

// GetByID, ID ile bir arkadaşlık kaydı döner.
func (r *sqliteFriendshipRepo) GetByID(ctx context.Context, id string) (*models.Friendship, error) {
	query := `SELECT id, user_id, friend_id, status, created_at, updated_at
	          FROM friendships WHERE id = ?`

	var f models.Friendship
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&f.ID, &f.UserID, &f.FriendID, &f.Status, &f.CreatedAt, &f.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: friendship %s", pkg.ErrNotFound, id)
	}
	if err != nil {
		return nil, fmt.Errorf("friendship get by id: %w", err)
	}
	return &f, nil
}

// GetByPair, iki kullanıcı arasındaki kaydı döner (yön fark etmez).
// A→B veya B→A kaydı varsa onu döner.
func (r *sqliteFriendshipRepo) GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error) {
	query := `SELECT id, user_id, friend_id, status, created_at, updated_at
	          FROM friendships
	          WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`

	var f models.Friendship
	err := r.db.QueryRowContext(ctx, query, userID, friendID, friendID, userID).Scan(
		&f.ID, &f.UserID, &f.FriendID, &f.Status, &f.CreatedAt, &f.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: friendship between %s and %s", pkg.ErrNotFound, userID, friendID)
	}
	if err != nil {
		return nil, fmt.Errorf("friendship get by pair: %w", err)
	}
	return &f, nil
}

// ListFriends, kullanıcının kabul edilmiş arkadaşlarını kullanıcı bilgisiyle döner.
//
// UNION sorgusu:
// 1) user_id = me → friend bilgileri (ben gönderdim, karşı taraf kabul etti)
// 2) friend_id = me → user bilgileri (karşı taraf gönderdi, ben kabul ettim)
//
// UNION ALL yerine UNION kullanılır — duplicate olmaması garanti
// (UNIQUE constraint bunu zaten engelliyor ama defense-in-depth).
func (r *sqliteFriendshipRepo) ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	query := `
		SELECT f.id, f.status, f.created_at AS created_at,
		       u.id, u.username, COALESCE(u.display_name, ''), u.avatar_url, u.status, u.custom_status
		FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ? AND f.status = 'accepted'

		UNION

		SELECT f.id, f.status, f.created_at AS created_at,
		       u.id, u.username, COALESCE(u.display_name, ''), u.avatar_url, u.status, u.custom_status
		FROM friendships f
		JOIN users u ON u.id = f.user_id
		WHERE f.friend_id = ? AND f.status = 'accepted'

		ORDER BY created_at DESC
	`

	rows, err := r.db.QueryContext(ctx, query, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("friendship list friends: %w", err)
	}
	defer rows.Close()

	friends := []models.FriendshipWithUser{}
	for rows.Next() {
		var fw models.FriendshipWithUser
		var displayName string
		var avatarURL, customStatus sql.NullString

		if err := rows.Scan(
			&fw.ID, &fw.Status, &fw.CreatedAt,
			&fw.UserID, &fw.Username, &displayName, &avatarURL, &fw.UserStatus, &customStatus,
		); err != nil {
			return nil, fmt.Errorf("friendship list friends scan: %w", err)
		}

		if displayName != "" {
			fw.DisplayName = &displayName
		}
		if avatarURL.Valid {
			fw.AvatarURL = &avatarURL.String
		}
		if customStatus.Valid {
			fw.UserCustomStatus = &customStatus.String
		}

		friends = append(friends, fw)
	}

	return friends, rows.Err()
}

// ListIncoming, kullanıcıya gelen bekleyen istekleri döner.
// friend_id = me AND status = 'pending' — karşı tarafın bilgileri JOIN ile gelir.
func (r *sqliteFriendshipRepo) ListIncoming(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	query := `
		SELECT f.id, f.status, f.created_at,
		       u.id, u.username, COALESCE(u.display_name, ''), u.avatar_url, u.status, u.custom_status
		FROM friendships f
		JOIN users u ON u.id = f.user_id
		WHERE f.friend_id = ? AND f.status = 'pending'
		ORDER BY f.created_at DESC
	`

	return r.scanFriendshipList(ctx, query, userID)
}

// ListOutgoing, kullanıcının gönderdiği bekleyen istekleri döner.
// user_id = me AND status = 'pending' — hedef kullanıcının bilgileri JOIN ile gelir.
func (r *sqliteFriendshipRepo) ListOutgoing(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	query := `
		SELECT f.id, f.status, f.created_at,
		       u.id, u.username, COALESCE(u.display_name, ''), u.avatar_url, u.status, u.custom_status
		FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ? AND f.status = 'pending'
		ORDER BY f.created_at DESC
	`

	return r.scanFriendshipList(ctx, query, userID)
}

// UpdateStatus, bir arkadaşlık kaydının durumunu günceller.
func (r *sqliteFriendshipRepo) UpdateStatus(ctx context.Context, id string, status models.FriendshipStatus) error {
	query := `UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, status, time.Now().UTC(), id)
	if err != nil {
		return fmt.Errorf("friendship update status: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("friendship update status rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: friendship %s", pkg.ErrNotFound, id)
	}

	return nil
}

// Delete, bir arkadaşlık kaydını ID ile siler.
func (r *sqliteFriendshipRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM friendships WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("friendship delete: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("friendship delete rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: friendship %s", pkg.ErrNotFound, id)
	}

	return nil
}

// DeleteByPair, iki kullanıcı arasındaki kaydı siler (yön fark etmez).
func (r *sqliteFriendshipRepo) DeleteByPair(ctx context.Context, userID, friendID string) error {
	query := `DELETE FROM friendships
	          WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`

	result, err := r.db.ExecContext(ctx, query, userID, friendID, friendID, userID)
	if err != nil {
		return fmt.Errorf("friendship delete by pair: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("friendship delete by pair rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: friendship between %s and %s", pkg.ErrNotFound, userID, friendID)
	}

	return nil
}

// scanFriendshipList, ortak scan mantığını paylaşan yardımcı metod.
// ListIncoming ve ListOutgoing aynı column set'ini döner — DRY prensibi.
func (r *sqliteFriendshipRepo) scanFriendshipList(ctx context.Context, query string, userID string) ([]models.FriendshipWithUser, error) {
	rows, err := r.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("friendship list: %w", err)
	}
	defer rows.Close()

	results := []models.FriendshipWithUser{}
	for rows.Next() {
		var fw models.FriendshipWithUser
		var displayName string
		var avatarURL, customStatus sql.NullString

		if err := rows.Scan(
			&fw.ID, &fw.Status, &fw.CreatedAt,
			&fw.UserID, &fw.Username, &displayName, &avatarURL, &fw.UserStatus, &customStatus,
		); err != nil {
			return nil, fmt.Errorf("friendship list scan: %w", err)
		}

		if displayName != "" {
			fw.DisplayName = &displayName
		}
		if avatarURL.Valid {
			fw.AvatarURL = &avatarURL.String
		}
		if customStatus.Valid {
			fw.UserCustomStatus = &customStatus.String
		}

		results = append(results, fw)
	}

	return results, rows.Err()
}
