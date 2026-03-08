package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqlitePinRepo struct {
	db database.TxQuerier
}

func NewSQLitePinRepo(db database.TxQuerier) PinRepository {
	return &sqlitePinRepo{db: db}
}

// GetByChannelID returns all pinned messages with message and author details.
// 3-way JOIN: pinned_messages -> messages -> users.
func (r *sqlitePinRepo) GetByChannelID(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	query := `
		SELECT p.id, p.message_id, p.channel_id, p.pinned_by, p.created_at,
		       m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       u.id, u.username, u.display_name, u.avatar_url, u.status,
		       pb.id, pb.username, pb.display_name, pb.avatar_url
		FROM pinned_messages p
		LEFT JOIN messages m ON p.message_id = m.id
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN users pb ON p.pinned_by = pb.id
		WHERE p.channel_id = ?
		ORDER BY p.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned messages: %w", err)
	}
	defer rows.Close()

	var pins []models.PinnedMessageWithDetails
	for rows.Next() {
		var pin models.PinnedMessageWithDetails
		var msg models.Message
		var author models.User
		var authorID sql.NullString
		var pinnedByUser models.User
		var pinnedByID sql.NullString

		if err := rows.Scan(
			&pin.ID, &pin.MessageID, &pin.ChannelID, &pin.PinnedBy, &pin.CreatedAt,
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status,
			&pinnedByID, &pinnedByUser.Username, &pinnedByUser.DisplayName, &pinnedByUser.AvatarURL,
		); err != nil {
			return nil, fmt.Errorf("failed to scan pinned message row: %w", err)
		}

		if authorID.Valid {
			author.ID = authorID.String
			author.PasswordHash = ""
			msg.Author = &author
		}
		msg.Attachments = []models.Attachment{} // empty slice, not null
		pin.Message = &msg

		if pinnedByID.Valid {
			pinnedByUser.ID = pinnedByID.String
			pinnedByUser.PasswordHash = ""
			pin.PinnedByUser = &pinnedByUser
		}

		pins = append(pins, pin)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating pinned message rows: %w", err)
	}

	if pins == nil {
		pins = []models.PinnedMessageWithDetails{}
	}

	return pins, nil
}

// Pin pins a message. Returns ErrAlreadyExists if already pinned (UNIQUE constraint).
func (r *sqlitePinRepo) Pin(ctx context.Context, pin *models.PinnedMessage) error {
	query := `
		INSERT INTO pinned_messages (id, message_id, channel_id, pinned_by)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		pin.MessageID,
		pin.ChannelID,
		pin.PinnedBy,
	).Scan(&pin.ID, &pin.CreatedAt)

	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			return fmt.Errorf("%w: message is already pinned", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to pin message: %w", err)
	}

	return nil
}

func (r *sqlitePinRepo) Unpin(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM pinned_messages WHERE message_id = ?`, messageID)
	if err != nil {
		return fmt.Errorf("failed to unpin message: %w", err)
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

func (r *sqlitePinRepo) IsPinned(ctx context.Context, messageID string) (bool, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pinned_messages WHERE message_id = ?`, messageID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check pin status: %w", err)
	}
	return count > 0, nil
}

// CountByChannelID returns the pin count for a channel. Used to enforce per-channel pin limits.
func (r *sqlitePinRepo) CountByChannelID(ctx context.Context, channelID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pinned_messages WHERE channel_id = ?`, channelID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count pinned messages: %w", err)
	}
	return count, nil
}
