package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

type sqliteDMRepo struct {
	db database.TxQuerier
}

func NewSQLiteDMRepo(db database.TxQuerier) DMRepository {
	return &sqliteDMRepo{db: db}
}

// ─── Channel Operations ───

// GetChannelByUsers returns the DM channel between two users.
// user1ID and user2ID must be pre-sorted (enforced by service layer).
func (r *sqliteDMRepo) GetChannelByUsers(ctx context.Context, user1ID, user2ID string) (*models.DMChannel, error) {
	var ch models.DMChannel
	var lastMsgAt sql.NullTime
	var initiatedBy sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, e2ee_enabled, status, initiated_by, created_at, last_message_at FROM dm_channels WHERE user1_id = ? AND user2_id = ?",
		user1ID, user2ID,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt)

	if err == sql.ErrNoRows {
		return nil, nil // no channel exists
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	if lastMsgAt.Valid {
		ch.LastMessageAt = &lastMsgAt.Time
	}
	if initiatedBy.Valid {
		ch.InitiatedBy = &initiatedBy.String
	}
	return &ch, nil
}

func (r *sqliteDMRepo) GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error) {
	var ch models.DMChannel
	var lastMsgAt sql.NullTime
	var initiatedBy sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, user1_id, user2_id, e2ee_enabled, status, initiated_by, created_at, last_message_at FROM dm_channels WHERE id = ?",
		id,
	).Scan(&ch.ID, &ch.User1ID, &ch.User2ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM channel not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM channel: %w", err)
	}
	if lastMsgAt.Valid {
		ch.LastMessageAt = &lastMsgAt.Time
	}
	if initiatedBy.Valid {
		ch.InitiatedBy = &initiatedBy.String
	}
	return &ch, nil
}

// ListChannels returns a user's DM channels with the other user's info.
// Joins user_dm_settings to filter hidden channels and include pin/mute state.
// Sorted: pinned first (by activity), then unpinned by activity.
func (r *sqliteDMRepo) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	query := `
		SELECT dc.id, dc.e2ee_enabled, dc.status, dc.initiated_by, dc.created_at, dc.last_message_at,
			u.id, u.username, u.display_name, u.avatar_url, u.status,
			COALESCE(ds.is_pinned, 0),
			CASE WHEN ds.muted_until IS NOT NULL AND ds.muted_until > datetime('now') THEN 1 ELSE 0 END
		FROM dm_channels dc
		JOIN users u ON u.id = CASE
			WHEN dc.user1_id = ? THEN dc.user2_id
			ELSE dc.user1_id
		END
		LEFT JOIN user_dm_settings ds ON ds.user_id = ? AND ds.dm_channel_id = dc.id
		WHERE (dc.user1_id = ? OR dc.user2_id = ?)
		  AND COALESCE(ds.is_hidden, 0) = 0
		ORDER BY COALESCE(ds.is_pinned, 0) DESC,
		         COALESCE(dc.last_message_at, dc.created_at) DESC`

	rows, err := r.db.QueryContext(ctx, query, userID, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list DM channels: %w", err)
	}
	defer rows.Close()

	var channels []models.DMChannelWithUser
	for rows.Next() {
		var ch models.DMChannelWithUser
		var user models.User
		var displayName, avatarURL, initiatedBy sql.NullString
		var lastMsgAt sql.NullTime
		var isPinned, isMuted int

		if err := rows.Scan(
			&ch.ID, &ch.E2EEEnabled, &ch.Status, &initiatedBy, &ch.CreatedAt, &lastMsgAt,
			&user.ID, &user.Username, &displayName, &avatarURL, &user.Status,
			&isPinned, &isMuted,
		); err != nil {
			return nil, fmt.Errorf("failed to scan DM channel: %w", err)
		}

		if lastMsgAt.Valid {
			ch.LastMessageAt = &lastMsgAt.Time
		}
		if displayName.Valid {
			user.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			user.AvatarURL = &avatarURL.String
		}
		if initiatedBy.Valid {
			ch.InitiatedBy = &initiatedBy.String
		}

		ch.OtherUser = &user
		ch.IsPinned = isPinned == 1
		ch.IsMuted = isMuted == 1
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

func (r *sqliteDMRepo) CreateChannel(ctx context.Context, channel *models.DMChannel) error {
	var lastMsgAt sql.NullTime
	err := r.db.QueryRowContext(ctx,
		"INSERT INTO dm_channels (user1_id, user2_id, status, initiated_by) VALUES (?, ?, ?, ?) RETURNING id, created_at, last_message_at",
		channel.User1ID, channel.User2ID, channel.Status, channel.InitiatedBy,
	).Scan(&channel.ID, &channel.CreatedAt, &lastMsgAt)

	if err != nil {
		return fmt.Errorf("failed to create DM channel: %w", err)
	}
	if lastMsgAt.Valid {
		channel.LastMessageAt = &lastMsgAt.Time
	}
	return nil
}

func (r *sqliteDMRepo) UpdateChannelStatus(ctx context.Context, channelID, status string) error {
	_, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET status = ? WHERE id = ?",
		status, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to update DM channel status: %w", err)
	}
	return nil
}

func (r *sqliteDMRepo) CountMessagesBySender(ctx context.Context, channelID, userID string) (int, error) {
	var count int
	err := r.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id = ? AND user_id = ?",
		channelID, userID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count messages: %w", err)
	}
	return count, nil
}

func (r *sqliteDMRepo) DeleteChannel(ctx context.Context, channelID string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM dm_messages WHERE dm_channel_id = ?", channelID)
	if err != nil {
		return fmt.Errorf("failed to delete DM messages: %w", err)
	}
	_, err = r.db.ExecContext(ctx, "DELETE FROM dm_channels WHERE id = ?", channelID)
	if err != nil {
		return fmt.Errorf("failed to delete DM channel: %w", err)
	}
	return nil
}

func (r *sqliteDMRepo) SetE2EEEnabled(ctx context.Context, channelID string, enabled bool) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_channels SET e2ee_enabled = ? WHERE id = ?",
		enabled, channelID,
	)
	if err != nil {
		return fmt.Errorf("failed to update DM E2EE: %w", err)
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

// ─── Message Operations ───

// GetMessages returns DM messages with cursor-based pagination (DESC order).
// Reply references loaded via LEFT JOIN, same pattern as channel messages.
func (r *sqliteDMRepo) GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error) {
	var query string
	var args []any

	if beforeID == "" {
		query = `
			SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       m.reply_to_id, m.is_pinned,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url
			FROM dm_messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.dm_channel_id = ?
			ORDER BY m.created_at DESC
			LIMIT ?`
		args = []any{channelID, limit}
	} else {
		query = `
			SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       m.reply_to_id, m.is_pinned,
			       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
			       u.id, u.username, u.display_name, u.avatar_url, u.status,
			       rm.id, rm.content,
			       ru.id, ru.username, ru.display_name, ru.avatar_url
			FROM dm_messages m
			LEFT JOIN users u ON m.user_id = u.id
			LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
			LEFT JOIN users ru ON rm.user_id = ru.id
			WHERE m.dm_channel_id = ?
			  AND m.created_at < (SELECT created_at FROM dm_messages WHERE id = ?)
			ORDER BY m.created_at DESC
			LIMIT ?`
		args = []any{channelID, beforeID, limit}
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		msg, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, *msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating DM messages: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, nil
}

func (r *sqliteDMRepo) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url
		FROM dm_messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.id = ?`

	var msg models.DMMessage
	var author models.User
	var authorID sql.NullString
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL sql.NullString
	var isPinned int

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &author.Username, &displayName, &avatarURL, &author.Status,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: DM message not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get DM message: %w", err)
	}

	msg.IsPinned = isPinned == 1
	if content.Valid {
		msg.Content = &content.String
	}
	if editedAt.Valid {
		msg.EditedAt = &editedAt.Time
	}
	if authorID.Valid {
		author.ID = authorID.String
		if displayName.Valid {
			author.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			author.AvatarURL = &avatarURL.String
		}
		msg.Author = &author
	}

	msg.ReferencedMessage = buildMessageReference(
		msg.ReplyToID, refMsgID, refMsgContent,
		refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL,
	)

	return &msg, nil
}

func (r *sqliteDMRepo) CreateMessage(ctx context.Context, msg *models.DMMessage) error {
	// Content can be nil (file-only message)
	var contentPtr *string
	if msg.Content != nil && *msg.Content != "" {
		contentPtr = msg.Content
	}

	err := r.db.QueryRowContext(ctx,
		`INSERT INTO dm_messages (dm_channel_id, user_id, content, reply_to_id,
			encryption_version, ciphertext, sender_device_id, e2ee_metadata)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
		msg.DMChannelID, msg.UserID, contentPtr, msg.ReplyToID,
		msg.EncryptionVersion, msg.Ciphertext, msg.SenderDeviceID, msg.E2EEMetadata,
	).Scan(&msg.ID, &msg.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create DM message: %w", err)
	}
	msg.CreatedAt = msg.CreatedAt.UTC()
	return nil
}

// UpdateMessage edits a DM message.
// E2EE messages update ciphertext; plaintext messages update content.
func (r *sqliteDMRepo) UpdateMessage(ctx context.Context, id string, req *models.UpdateDMMessageRequest) error {
	now := time.Now().UTC()

	var result sql.Result
	var err error

	if req.EncryptionVersion == 1 {
		result, err = r.db.ExecContext(ctx,
			`UPDATE dm_messages SET ciphertext = ?, sender_device_id = ?, e2ee_metadata = ?, edited_at = ? WHERE id = ?`,
			req.Ciphertext, req.SenderDeviceID, req.E2EEMetadata, now, id,
		)
	} else {
		result, err = r.db.ExecContext(ctx,
			"UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?",
			req.Content, now, id,
		)
	}

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

// ─── Reaction Operations ───

// ToggleReaction adds or removes a DM reaction.
// INSERT OR IGNORE -> if rowsAffected == 0 (UNIQUE hit) -> DELETE. Atomic toggle.
func (r *sqliteDMRepo) ToggleReaction(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	insertQuery := `
		INSERT OR IGNORE INTO dm_reactions (id, dm_message_id, user_id, emoji)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)`

	result, err := r.db.ExecContext(ctx, insertQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction insert: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction rows affected: %w", err)
	}

	if rowsAffected > 0 {
		return true, nil // added
	}

	// Already exists -> remove
	deleteQuery := `DELETE FROM dm_reactions WHERE dm_message_id = ? AND user_id = ? AND emoji = ?`
	_, err = r.db.ExecContext(ctx, deleteQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction delete: %w", err)
	}

	return false, nil
}

func (r *sqliteDMRepo) GetReactionsByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error) {
	query := `
		SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM dm_reactions
		WHERE dm_message_id = ?
		GROUP BY emoji
		ORDER BY MIN(created_at) ASC`

	rows, err := r.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("get DM reactions by message: %w", err)
	}
	defer rows.Close()

	return scanReactionGroups(rows)
}

// GetReactionsByMessageIDs batch-loads reactions for multiple DM messages (avoids N+1).
func (r *sqliteDMRepo) GetReactionsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.ReactionGroup), nil
	}

	placeholders := make([]string, len(messageIDs))
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT dm_message_id, emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM dm_reactions
		WHERE dm_message_id IN (%s)
		GROUP BY dm_message_id, emoji
		ORDER BY dm_message_id, MIN(created_at) ASC`,
		strings.Join(placeholders, ","))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get DM reactions by message ids: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.ReactionGroup)
	for rows.Next() {
		var messageID, emoji, usersStr string
		var count int
		if err := rows.Scan(&messageID, &emoji, &count, &usersStr); err != nil {
			return nil, fmt.Errorf("scan DM reaction group: %w", err)
		}

		users := strings.Split(usersStr, ",")
		result[messageID] = append(result[messageID], models.ReactionGroup{
			Emoji: emoji,
			Count: count,
			Users: users,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate DM reaction rows: %w", err)
	}

	return result, nil
}

// ─── Pin Operations ───

func (r *sqliteDMRepo) PinMessage(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_messages SET is_pinned = 1 WHERE id = ?", messageID,
	)
	if err != nil {
		return fmt.Errorf("failed to pin DM message: %w", err)
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

func (r *sqliteDMRepo) UnpinMessage(ctx context.Context, messageID string) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE dm_messages SET is_pinned = 0 WHERE id = ?", messageID,
	)
	if err != nil {
		return fmt.Errorf("failed to unpin DM message: %w", err)
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

func (r *sqliteDMRepo) GetPinnedMessages(ctx context.Context, channelID string) ([]models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url
		FROM dm_messages m
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.dm_channel_id = ? AND m.is_pinned = 1
		ORDER BY m.created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		msg, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, *msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating pinned DM messages: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, nil
}

// ─── Attachment Operations ───

func (r *sqliteDMRepo) CreateAttachment(ctx context.Context, attachment *models.DMAttachment) error {
	err := r.db.QueryRowContext(ctx,
		`INSERT INTO dm_attachments (dm_message_id, filename, file_url, file_size, mime_type)
		 VALUES (?, ?, ?, ?, ?) RETURNING id, created_at`,
		attachment.DMMessageID, attachment.Filename, attachment.FileURL, attachment.FileSize, attachment.MimeType,
	).Scan(&attachment.ID, &attachment.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create DM attachment: %w", err)
	}
	return nil
}

// GetAttachmentsByMessageIDs batch-loads attachments for multiple DM messages (avoids N+1).
func (r *sqliteDMRepo) GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.DMAttachment, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.DMAttachment), nil
	}

	placeholders := strings.Repeat("?,", len(messageIDs))
	placeholders = placeholders[:len(placeholders)-1]

	query := fmt.Sprintf(`
		SELECT id, dm_message_id, filename, file_url, file_size, mime_type, created_at
		FROM dm_attachments
		WHERE dm_message_id IN (%s)
		ORDER BY created_at ASC`, placeholders)

	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get DM attachments by message ids: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.DMAttachment)
	for rows.Next() {
		var a models.DMAttachment
		if err := rows.Scan(
			&a.ID, &a.DMMessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan DM attachment row: %w", err)
		}
		result[a.DMMessageID] = append(result[a.DMMessageID], a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate DM attachment rows: %w", err)
	}

	return result, nil
}

// ─── Search Operations ───

// SearchMessages performs FTS5 full-text search on DM messages.
// Returns paginated results ranked by BM25, plus total count for pagination.
func (r *sqliteDMRepo) SearchMessages(ctx context.Context, channelID string, searchQuery string, limit, offset int) ([]models.DMMessage, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	safeQuery := sanitizeFTSQuery(searchQuery)
	if safeQuery == "" {
		return []models.DMMessage{}, 0, nil
	}

	// Total count
	countQuery := `
		SELECT COUNT(*)
		FROM dm_messages_fts fts
		JOIN dm_messages m ON m.rowid = fts.rowid
		WHERE dm_messages_fts MATCH ? AND m.dm_channel_id = ?`

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, safeQuery, channelID).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count DM search results: %w", err)
	}

	if totalCount == 0 {
		return []models.DMMessage{}, 0, nil
	}

	// Paginated results ranked by BM25
	dataQuery := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
		       m.encryption_version, m.ciphertext, m.sender_device_id, m.e2ee_metadata,
		       u.id, u.username, u.display_name, u.avatar_url, u.status,
		       rm.id, rm.content,
		       ru.id, ru.username, ru.display_name, ru.avatar_url
		FROM dm_messages m
		JOIN dm_messages_fts fts ON fts.rowid = m.rowid
		LEFT JOIN users u ON m.user_id = u.id
		LEFT JOIN dm_messages rm ON m.reply_to_id = rm.id
		LEFT JOIN users ru ON rm.user_id = ru.id
		WHERE m.dm_channel_id = ? AND fts.content MATCH ?
		ORDER BY fts.rank
		LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, dataQuery, channelID, safeQuery, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to search DM messages: %w", err)
	}
	defer rows.Close()

	var messages []models.DMMessage
	for rows.Next() {
		msg, err := scanDMMessageRow(rows)
		if err != nil {
			return nil, 0, err
		}
		messages = append(messages, *msg)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating DM search results: %w", err)
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}
	return messages, totalCount, nil
}

// ─── Scan Helpers ───

// scanDMMessageRow parses a standard DM message query row including author and reply reference.
func scanDMMessageRow(rows *sql.Rows) (*models.DMMessage, error) {
	var msg models.DMMessage
	var author models.User
	var authorID sql.NullString
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL sql.NullString
	var isPinned int

	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString

	if err := rows.Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
		&msg.EncryptionVersion, &msg.Ciphertext, &msg.SenderDeviceID, &msg.E2EEMetadata,
		&authorID, &author.Username, &displayName, &avatarURL, &author.Status,
		&refMsgID, &refMsgContent,
		&refAuthorID, &refAuthorUsername, &refAuthorDisplayName, &refAuthorAvatarURL,
	); err != nil {
		return nil, fmt.Errorf("failed to scan DM message: %w", err)
	}

	msg.IsPinned = isPinned == 1
	if content.Valid {
		msg.Content = &content.String
	}
	if editedAt.Valid {
		msg.EditedAt = &editedAt.Time
	}
	if authorID.Valid {
		author.ID = authorID.String
		if displayName.Valid {
			author.DisplayName = &displayName.String
		}
		if avatarURL.Valid {
			author.AvatarURL = &avatarURL.String
		}
		msg.Author = &author
	}

	msg.ReferencedMessage = buildMessageReference(
		msg.ReplyToID, refMsgID, refMsgContent,
		refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL,
	)

	return &msg, nil
}
