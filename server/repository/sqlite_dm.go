package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
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
//
// Channel GetByChannelID ile aynı pattern:
// - LEFT JOIN ile referans mesaj (reply preview) yüklenir
// - reply_to_id ve is_pinned alanları dahil
// - Attachments ve reactions service katmanında batch load edilir
func (r *sqliteDMRepo) GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error) {
	var query string
	var args []any

	if beforeID == "" {
		query = `
			SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       m.reply_to_id, m.is_pinned,
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

// GetMessageByID, tek bir DM mesajını döner (yazar + reply bilgisiyle).
func (r *sqliteDMRepo) GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
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

	// Referans mesaj nullable alanları
	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
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

	// Referans mesaj (reply preview) — buildMessageReference channel'da tanımlı,
	// DM için aynı pattern'ı kullanıyoruz.
	msg.ReferencedMessage = buildMessageReference(
		msg.ReplyToID, refMsgID, refMsgContent,
		refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL,
	)

	return &msg, nil
}

// CreateMessage, yeni bir DM mesajı oluşturur.
// reply_to_id desteği dahil — yanıt mesajları için kullanılır.
func (r *sqliteDMRepo) CreateMessage(ctx context.Context, msg *models.DMMessage) error {
	// Content boş olabilir (sadece dosya mesajı) — nullable olarak ekle
	var contentPtr *string
	if msg.Content != nil && *msg.Content != "" {
		contentPtr = msg.Content
	}

	err := r.db.QueryRowContext(ctx,
		"INSERT INTO dm_messages (dm_channel_id, user_id, content, reply_to_id) VALUES (?, ?, ?, ?) RETURNING id, created_at",
		msg.DMChannelID, msg.UserID, contentPtr, msg.ReplyToID,
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

// ─── Reaction Operations ───

// ToggleReaction, bir DM reaction'ı ekler veya kaldırır.
//
// Channel reaction toggle pattern ile aynı:
// INSERT OR IGNORE → rowsAffected == 0 → UNIQUE constraint → zaten var → DELETE.
// Atomik toggle, race condition riski yok (UNIQUE constraint DB seviyesinde).
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

	// INSERT başarılı — yeni reaction eklendi
	if rowsAffected > 0 {
		return true, nil
	}

	// INSERT başarısız (UNIQUE constraint) — reaction zaten var, sil
	deleteQuery := `DELETE FROM dm_reactions WHERE dm_message_id = ? AND user_id = ? AND emoji = ?`
	_, err = r.db.ExecContext(ctx, deleteQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle DM reaction delete: %w", err)
	}

	return false, nil
}

// GetReactionsByMessageID, tek bir DM mesajının reaction'larını gruplanmış döner.
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

// GetReactionsByMessageIDs, birden fazla DM mesajının reaction'larını batch yükler.
// N+1 problemi çözümü — tek sorgu ile tüm mesajların reaction'ları alınır.
//
// Return: map[messageID] → []ReactionGroup
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

// PinMessage, bir DM mesajını sabitler.
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

// UnpinMessage, bir DM mesajının sabitlemesini kaldırır.
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

// GetPinnedMessages, bir DM kanalının sabitlenmiş mesajlarını döner.
// Sabitlenme zamanına göre en yeni üstte sıralanır.
func (r *sqliteDMRepo) GetPinnedMessages(ctx context.Context, channelID string) ([]models.DMMessage, error) {
	query := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
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

// CreateAttachment, yeni bir DM dosya eki kaydeder.
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

// GetAttachmentsByMessageIDs, birden fazla DM mesajının dosya eklerini batch yükler.
// N+1 problemi çözümü — tek sorgu ile tüm mesajların attachment'ları alınır.
//
// Return: map[messageID] → []DMAttachment
func (r *sqliteDMRepo) GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.DMAttachment, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.DMAttachment), nil
	}

	placeholders := strings.Repeat("?,", len(messageIDs))
	placeholders = placeholders[:len(placeholders)-1] // Son virgülü kaldır

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

// SearchMessages, FTS5 tam metin araması ile DM mesajlarını döner.
//
// FTS5 (Full-Text Search) SQLite'ın yerleşik arama motoru.
// dm_messages_fts virtual tablosu triggerlar ile senkronize kalır.
// MATCH operatörü ile fulltext arama yapılır.
//
// Channel search ile aynı pattern:
// 1. sanitizeFTSQuery ile güvenli FTS5 sorgusu oluştur
// 2. COUNT(*) ile toplam sonuç sayısını al
// 3. LIMIT/OFFSET ile sayfalanmış sonuçları getir
//
// Sonuçlar yazar bilgisiyle birlikte döner, BM25 ranking ile sıralanır.
// Üçüncü return değeri toplam sonuç sayısıdır (pagination hesaplaması için).
func (r *sqliteDMRepo) SearchMessages(ctx context.Context, channelID string, searchQuery string, limit, offset int) ([]models.DMMessage, int, error) {
	// Limit/offset koruma — channel search ile aynı validation
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	// FTS5 query sanitize — channel search'teki sanitizeFTSQuery ile aynı
	safeQuery := sanitizeFTSQuery(searchQuery)
	if safeQuery == "" {
		return []models.DMMessage{}, 0, nil
	}

	// 1. Toplam sonuç sayısı
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

	// 2. Sayfalanmış sonuçlar — BM25 ranking ile sıralanır
	dataQuery := `
		SELECT m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
		       m.reply_to_id, m.is_pinned,
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

// scanDMMessageRow, standart DM mesaj sorgusunun bir satırını parse eder.
//
// Beklenen sütun sırası:
// m.id, m.dm_channel_id, m.user_id, m.content, m.edited_at, m.created_at,
// m.reply_to_id, m.is_pinned,
// u.id, u.username, u.display_name, u.avatar_url, u.status,
// rm.id, rm.content,
// ru.id, ru.username, ru.display_name, ru.avatar_url
//
// Channel sqlite_message.go'daki scan pattern ile aynı yapı.
func scanDMMessageRow(rows *sql.Rows) (*models.DMMessage, error) {
	var msg models.DMMessage
	var author models.User
	var authorID sql.NullString
	var content sql.NullString
	var editedAt sql.NullTime
	var displayName, avatarURL sql.NullString
	var isPinned int

	// Referans mesaj nullable alanları
	var refMsgID, refMsgContent sql.NullString
	var refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL sql.NullString

	if err := rows.Scan(
		&msg.ID, &msg.DMChannelID, &msg.UserID, &content, &editedAt, &msg.CreatedAt,
		&msg.ReplyToID, &isPinned,
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

	// Referans mesaj (reply preview) — channel'daki buildMessageReference ile aynı
	msg.ReferencedMessage = buildMessageReference(
		msg.ReplyToID, refMsgID, refMsgContent,
		refAuthorID, refAuthorUsername, refAuthorDisplayName, refAuthorAvatarURL,
	)

	return &msg, nil
}
