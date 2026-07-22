package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteMessageRepo struct {
	db database.TxQuerier
}

func NewSQLiteMessageRepo(db database.TxQuerier) MessageRepository {
	return &sqliteMessageRepo{db: db}
}

func (r *sqliteMessageRepo) Create(ctx context.Context, message *models.Message) error {
	query := `
		INSERT INTO messages (id, channel_id, user_id, content, reply_to_id,
			encryption_version, ciphertext, sender_device_id, e2ee_metadata)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		message.ChannelID,
		message.UserID,
		message.Content,
		message.ReplyToID,
		message.EncryptionVersion,
		message.Ciphertext,
		message.SenderDeviceID,
		message.E2EEMetadata,
	).Scan(&message.ID, &message.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create message: %w", err)
	}

	return nil
}

func (r *sqliteMessageRepo) GetByID(ctx context.Context, id string) (*models.Message, error) {
	// LEFT JOIN: message stays visible even if author is deleted.
	// Reply reference (rm/ru) loaded via LEFT JOIN.
	query := `
		SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status, u.deleted_at, u.is_hard_deleted,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.deleted_at, ru.is_hard_deleted
		FROM messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.id = ?`

	msg := &models.Message{}
	var author models.User
	var authorID sql.NullString

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString
	var refAuthorDeletedAt sql.NullTime
	var refAuthorIsHardDeleted sql.NullBool

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.ReplyToID,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status, &author.DeletedAt, &author.IsHardDeleted,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorDeletedAt, &refAuthorIsHardDeleted,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get message by id: %w", err)
	}

	if authorID.Valid {
		author.ID = authorID.String
		author.PasswordHash = "" // never expose password hash
		msg.Author = &author
	}

	msg.ReferencedMessage = buildMessageReference(msg.ReplyToID, refMsgID, refMsgContent, refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorDeletedAt, refAuthorIsHardDeleted)

	return msg, nil
}

// GetByChannelID returns messages with cursor-based pagination.
// Reply references are loaded via LEFT JOIN (max 1 per message, so JOIN is preferred over batch).
// Results are DESC-ordered (frontend reverses for display).
func (r *sqliteMessageRepo) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error) {
	var query string
	var args []any

	if beforeID == "" {
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.deleted_at, u.is_hard_deleted,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.deleted_at, ru.is_hard_deleted
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.channel_id = ?
			ORDER BY m.created_at DESC
			LIMIT ?`
		args = []any{channelID, limit}
	} else {
		// Cursor pagination: fetch messages older than beforeID's created_at
		query = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at, m.reply_to_id,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status, u.deleted_at, u.is_hard_deleted,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url, ru.deleted_at, ru.is_hard_deleted
			FROM messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
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

		var refMsgID, refMsgContent sql.NullString
		var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString
		var refAuthorDeletedAt sql.NullTime
		var refAuthorIsHardDeleted sql.NullBool

		if err := rows.Scan(
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.ReplyToID,
			&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
			&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status, &author.DeletedAt, &author.IsHardDeleted,
			&refMsgID, &refMsgContent,
			&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL, &refAuthorDeletedAt, &refAuthorIsHardDeleted,
		); err != nil {
			return nil, fmt.Errorf("failed to scan message row: %w", err)
		}

		if authorID.Valid {
			author.ID = authorID.String
			author.PasswordHash = ""
			msg.Author = &author
		}

		msg.ReferencedMessage = buildMessageReference(msg.ReplyToID, refMsgID, refMsgContent, refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL, refAuthorDeletedAt, refAuthorIsHardDeleted)

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating message rows: %w", err)
	}

	return messages, nil
}

func (r *sqliteMessageRepo) Update(ctx context.Context, message *models.Message) error {
	now := time.Now()

	// The version the caller wants the row to end up at — which is not necessarily the one it has.
	// A server can toggle E2EE between a message being written and being edited, so the row has to
	// move to the edit's version and drop the other representation. Writing one side while leaving
	// the version and the other side stale is how an edit either vanished or wiped the original.
	var result sql.Result
	var err error
	if message.EncryptionVersion == 1 {
		result, err = r.db.ExecContext(ctx,
			`UPDATE messages
			 SET encryption_version = 1, ciphertext = ?, sender_device_id = ?, e2ee_metadata = ?,
			     content = NULL, edited_at = ?
			 WHERE id = ?`,
			message.Ciphertext, message.SenderDeviceID, message.E2EEMetadata, now, message.ID,
		)
	} else {
		result, err = r.db.ExecContext(ctx,
			`UPDATE messages
			 SET encryption_version = 0, content = ?, ciphertext = NULL, sender_device_id = NULL,
			     e2ee_metadata = NULL, edited_at = ?
			 WHERE id = ?`,
			message.Content, now, message.ID,
		)
	}
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
	// Attachments CASCADE-deleted. Reply references preserved (no FK):
	// reply_to_id stays, LEFT JOIN returns NULL -> frontend shows "deleted message".
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

// buildMessageReference builds a MessageReference from LEFT JOIN results.
//
// Three cases:
// 1. replyToID nil -> not a reply -> nil
// 2. replyToID set, refMsgID NULL -> referenced message deleted -> empty ref with ID only
// 3. replyToID set, refMsgID set -> full reference with author + content
func buildMessageReference(
	replyToID *string,
	refMsgID, refMsgContent sql.NullString,
	refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString,
	refAuthorDeletedAt sql.NullTime,
	refAuthorIsHardDeleted sql.NullBool,
) *models.MessageReference {
	if replyToID == nil {
		return nil
	}

	ref := &models.MessageReference{
		ID: *replyToID,
	}

	if refMsgID.Valid {
		if refMsgContent.Valid {
			ref.Content = &refMsgContent.String
		}

		if refAuthorID.Valid {
			refAuthor := &models.User{
				ID:       refAuthorID.String,
				Username: refAuthorUsername.String,
			}
			if refAuthorDisplayName.Valid {
				refAuthor.DisplayName = &refAuthorDisplayName.String
			}
			if refAuthorAvatarURL.Valid {
				refAuthor.AvatarURL = &refAuthorAvatarURL.String
			}
			if refAuthorDeletedAt.Valid {
				t := refAuthorDeletedAt.Time
				refAuthor.DeletedAt = &t
			}
			if refAuthorIsHardDeleted.Valid {
				refAuthor.IsHardDeleted = refAuthorIsHardDeleted.Bool
			}
			ref.Author = refAuthor
		}
	}
	// refMsgID invalid -> referenced message deleted, Author and Content stay nil

	return ref
}
