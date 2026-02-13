package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteDMRepo, DMRepository interface'inin SQLite implementasyonu.
type sqliteDMRepo struct {
	db *sql.DB
}

// NewSQLiteDMRepo, constructor — interface döner.
func NewSQLiteDMRepo(db *sql.DB) DMRepository {
	return &sqliteDMRepo{db: db}
}

// ─── Channel Operations ───

// GetChannelByUsers, iki kullanıcı arasındaki DM kanalını döner.
// user1ID ve user2ID sıralı gelmeli (service katmanında sağlanır).
func (r *sqliteDMRepo) GetChannelByUsers(ctx context.Context, user1ID, user2ID string) (*models.DMChannel, error) {
	var ch models.DMChannel
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, created_at FROM dm_channels WHERE user1_id = ? AND user2_id = ?",
		user1ID, user2ID,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.CreatedAt)

	if err == sql.ErrNoRows {
		return nil, nil // Kanal yok — nil döner (hata değil)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	return &ch, nil
}

// GetChannelByID, ID ile DM kanalını döner.
func (r *sqliteDMRepo) GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error) {
	var ch models.DMChannel
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, created_at FROM dm_channels WHERE id = ?",
		id,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.CreatedAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM channel not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	return &ch, nil
}

// ListChannels, bir kullanıcının tüm DM kanallarını karşı taraf bilgisiyle döner.
//
// JOIN mantığı:
// dm_channels.user1_id veya user2_id eşleşen kanalları bul,
// karşı tarafı (eşleşmeyen user) users tablosuyla JOIN et.
// Son mesaja göre sıralama: en son mesaj alan kanal üstte.
func (r *sqliteDMRepo) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	query := `
		SELECT dc.id, dc.created_at,
			u.id, u.username, u.display_name, u.avatar_url, u.status
		FROM dm_channels dc
		JOIN users u ON u.id = CASE
			WHEN dc.user1_id = ? THEN dc.user2_id
			ELSE dc.user1_id
		END
		WHERE dc.user1_id = ? OR dc.user2_id = ?
		ORDER BY dc.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list DM channels: %w", err)
	}
	defer rows.Close()

	var channels []models.DMChannelWithUser
	for rows.Next() {
		var ch models.DMChannelWithUser
		var user models.User
		var displayName, avatarURL sql.NullString

		if err := rows.Scan(
			&ch.ID, &ch.CreatedAt,
			&user.ID, &user.Username, &displayName, &avatarURL, &user.Status,
		); err != nil {
			return nil, fmt.Errorf("failed to scan DM channel: %w", err)
		}

		if displayName.Valid {
			user.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			user.AvatarURL = &avatarURL.String
		}

		ch.OtherUser = &user
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating DM channels: %w", err)
	}

	if channels == nil {
		channels = []models.DMChannelWithUser{}
	}
	return channels, nil
}

// CreateChannel, yeni bir DM kanalı oluşturur.
func (r *sqliteDMRepo) CreateChannel(ctx context.Context, channel *models.DMChannel) error {
	err := r.db.QueryRowContext(ctx,
		"INSERT INTO dm_channels (user1_id, user2_id) VALUES (?, ?) RETURNING id, created_at",
		channel.User1ID, channel.User2ID,
	).Scan(&channel.ID, &channel.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create DM channel: %w", err)
	}
	return nil
}

// ─── Message Operations ───

// GetMessages, cursor-based pagination ile DM mesajlarını döner.
// Mesajlar created_at DESC sıralı döner (service katmanında ters çevrilir).
func (r *sqliteDMRepo) GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error) {
	var rows *sql.Rows
	var err error

	baseQuery := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			u.id, u.username, u.display_name, u.avatar_url, u.status
		FROM dm_messages m
		JOIN users u ON u.id = m.user_id
		WHERE m.dm_channel_id = ?`

	if beforeID != "" {
		rows, err = r.db.QueryContext(ctx, baseQuery+
			" AND m.created_at < (SELECT created_at FROM dm_messages WHERE id = ?)"+
			" ORDER BY m.created_at DESC LIMIT ?",
			channelID, beforeID, limit,
		)
	} else {
		rows, err = r.db.QueryContext(ctx, baseQuery+
			" ORDER BY m.created_at DESC LIMIT ?",
			channelID, limit,
		)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		var msg models.DMMessage
		var author models.User
		var content sql.NullString
		var editedAt sql.NullTime
		var displayName, avatarURL sql.NullString

		if err := rows.Scan(
			&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
			&author.ID, &author.Username, &displayName, &avatarURL, &author.Status,
		); err != nil {
			return nil, fmt.Errorf("failed to scan DM message: %w", err)
		}

		if content.Valid {
			msg.Content = &content.String
		}
		if editedAt.Valid {
			msg.EditedAt = &editedAt.Time
		}
		if displayName.Valid {
			author.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			author.AvatarURL = &avatarURL.String
		}

		msg.Author = &author
		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating DM messages: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, nil
}

// GetMessageByID, tek bir DM mesajını döner (yazar bilgisiyle).
func (r *sqliteDMRepo) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	var msg models.DMMessage
	var author models.User
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL sql.NullString

	err := r.db.QueryRowContext(ctx, `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			u.id, u.username, u.display_name, u.avatar_url, u.status
		FROM dm_messages m
		JOIN users u ON u.id = m.user_id
		WHERE m.id = ?`, id,
	).Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&author.ID, &author.Username, &displayName, &avatarURL, &author.Status,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM message: %w", err)
	}

	if content.Valid {
		msg.Content = &content.String
	}
	if editedAt.Valid {
		msg.EditedAt = &editedAt.Time
	}
	if displayName.Valid {
		author.DisplayName = &displayName.String
	}
	if avatarURL.Valid {
		author.AvatarURL = &avatarURL.String
	}

	msg.Author = &author
	return &msg, nil
}

// CreateMessage, yeni bir DM mesajı oluşturur.
func (r *sqliteDMRepo) CreateMessage(ctx context.Context, msg *models.DMMessage) error {
	err := r.db.QueryRowContext(ctx,
		"INSERT INTO dm_messages (dm_channel_id, user_id, content) VALUES (?, ?, ?) RETURNING id, created_at",
		msg.DMChannelID, msg.UserID, msg.Content,
	).Scan(&msg.ID, &msg.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create DM message: %w", err)
	}
	// created_at SQLite default — timezone issue fix
	msg.CreatedAt = msg.CreatedAt.UTC()
	return nil
}

// UpdateMessage, bir DM mesajını düzenler.
func (r *sqliteDMRepo) UpdateMessage(ctx context.Context, id string, content string) error {
	now := time.Now().UTC()
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?",
		content, now, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update DM message: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	return nil
}

// DeleteMessage, bir DM mesajını siler.
func (r *sqliteDMRepo) DeleteMessage(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, "DELETE FROM dm_messages WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete DM message: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	return nil
}
