package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteMessageRepo, MessageRepository interface'inin SQLite implementasyonu.
type sqliteMessageRepo struct {
	db *sql.DB
}

// NewSQLiteMessageRepo, constructor — interface döner.
func NewSQLiteMessageRepo(db *sql.DB) MessageRepository {
	return &sqliteMessageRepo{db: db}
}

func (r *sqliteMessageRepo) Create(ctx context.Context, message *models.Message) error {
	query := `
		INSERT INTO messages (id, channel_id, user_id, content)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		message.ChannelID,
		message.UserID,
		message.Content,
	).Scan(&message.ID, &message.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create message: %w", err)
	}

	return nil
}

func (r *sqliteMessageRepo) GetByID(ctx context.Context, id string) (*models.Message, error) {
	// Mesajı yazar bilgisiyle birlikte getir (JOIN).
	// LEFT JOIN kullanıyoruz — kullanıcı silinmiş olsa bile mesaj görünür.
	query := `
		SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       u.id, u.username, u.display_name, u.avatar_url, u.status
		FROM messages m
		LEFT JOIN users u ON m.user_id = u.id
		WHERE m.id = ?`

	msg := &models.Message{}
	var author models.User
	var authorID sql.NullString

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get message by id: %w", err)
	}

	if authorID.Valid {
		author.ID = authorID.String
		author.PasswordHash = "" // Güvenlik: API'ye asla şifre hash'i gönderme
		msg.Author = &author
	}

	return msg, nil
}

// GetByChannelID, cursor-based pagination ile mesajları getirir.
//
// Sorgu mantığı:
// 1. beforeID boşsa → en yeni mesajlardan başla
// 2. beforeID doluysa → o mesajın created_at değerinden öncekileri getir
// 3. ORDER BY created_at DESC → en yeniden eskiye sırala
// 4. LIMIT ile sayı kısıtla
//
// Frontend'de mesajlar ters çevrilir (en eski üstte, en yeni altta).
func (r *sqliteMessageRepo) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error) {
	var query string
	var args []any

	if beforeID == "" {
		// İlk yükleme — en yeni mesajlardan başla
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			WHERE m.channel_id = ?
			ORDER BY m.created_at DESC
			LIMIT ?`
		args = []any{channelID, limit}
	} else {
		// Eski mesajları yükle — cursor'dan önceki mesajlar
		//
		// Subquery nedir?
		// "(SELECT created_at FROM messages WHERE id = ?)" — beforeID'nin created_at değerini bulur.
		// Ana sorgu bu tarihten önceki mesajları getirir.
		// Bu pattern, cursor-based pagination'ın temelidir.
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			WHERE m.channel_id = ?
			  AND m.created_at < (SELECT created_at FROM messages WHERE id = ?)
			ORDER BY m.created_at DESC
			LIMIT ?`
		args = []any{channelID, beforeID, limit}
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages by channel: %w", err)
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var msg models.Message
		var author models.User
		var authorID sql.NullString

		if err := rows.Scan(
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status,
		); err != nil {
			return nil, fmt.Errorf("failed to scan message row: %w", err)
		}

		if authorID.Valid {
			author.ID = authorID.String
			author.PasswordHash = ""
			msg.Author = &author
		}

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating message rows: %w", err)
	}

	return messages, nil
}

func (r *sqliteMessageRepo) Update(ctx context.Context, message *models.Message) error {
	// Düzenleme: content güncelle + edited_at zaman damgası ekle.
	now := time.Now()
	query := `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, message.Content, now, message.ID)
	if err != nil {
		return fmt.Errorf("failed to update message: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	message.EditedAt = &now
	return nil
}

func (r *sqliteMessageRepo) Delete(ctx context.Context, id string) error {
	// ON DELETE CASCADE: mesaj silindiğinde attachment'lar da silinir (DB tarafında).
	result, err := r.db.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete message: %w", err)
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
