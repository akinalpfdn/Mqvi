package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// sqliteAttachmentRepo, AttachmentRepository interface'inin SQLite implementasyonu.
type sqliteAttachmentRepo struct {
	db *sql.DB
}

// NewSQLiteAttachmentRepo, constructor — interface döner.
func NewSQLiteAttachmentRepo(db *sql.DB) AttachmentRepository {
	return &sqliteAttachmentRepo{db: db}
}

func (r *sqliteAttachmentRepo) Create(ctx context.Context, attachment *models.Attachment) error {
	query := `
		INSERT INTO attachments (id, message_id, filename, file_url, file_size, mime_type)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		attachment.MessageID,
		attachment.Filename,
		attachment.FileURL,
		attachment.FileSize,
		attachment.MimeType,
	).Scan(&attachment.ID, &attachment.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create attachment: %w", err)
	}

	return nil
}

func (r *sqliteAttachmentRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error) {
	query := `
		SELECT id, message_id, filename, file_url, file_size, mime_type, created_at
		FROM attachments WHERE message_id = ? ORDER BY created_at ASC`

	rows, err := r.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments by message: %w", err)
	}
	defer rows.Close()

	var attachments []models.Attachment
	for rows.Next() {
		var a models.Attachment
		if err := rows.Scan(
			&a.ID, &a.MessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan attachment row: %w", err)
		}
		attachments = append(attachments, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating attachment rows: %w", err)
	}

	return attachments, nil
}

// GetByMessageIDs, birden fazla mesajın attachment'larını tek sorguda yükler.
//
// Dynamic placeholder nedir?
// SQL'de "WHERE message_id IN (?, ?, ?)" yazarken ? sayısını sorgu zamanında belirleriz.
// Go'da strings.Repeat ile "?,?,?" dizesi oluşturup sorguya ekliyoruz.
// Her ? için args dizisine karşılık gelen message ID eklenir.
//
// Bu pattern N+1 problemini çözer:
// - Kötü: 50 mesaj → 50 ayrı SELECT sorgusu
// - İyi: 50 mesaj → 1 SELECT ... WHERE message_id IN (50 tane ?)
func (r *sqliteAttachmentRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	// Placeholder'ları oluştur: "?,?,?" (messageIDs sayısı kadar)
	placeholders := strings.Repeat("?,", len(messageIDs))
	placeholders = placeholders[:len(placeholders)-1] // Son virgülü kaldır

	query := fmt.Sprintf(`
		SELECT id, message_id, filename, file_url, file_size, mime_type, created_at
		FROM attachments WHERE message_id IN (%s) ORDER BY created_at ASC`, placeholders)

	// []string → []any dönüşümü (QueryContext variadic any kabul eder)
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments by message ids: %w", err)
	}
	defer rows.Close()

	var attachments []models.Attachment
	for rows.Next() {
		var a models.Attachment
		if err := rows.Scan(
			&a.ID, &a.MessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan attachment row: %w", err)
		}
		attachments = append(attachments, a)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating attachment rows: %w", err)
	}

	return attachments, nil
}

func (r *sqliteAttachmentRepo) Delete(ctx context.Context, id string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM attachments WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete attachment: %w", err)
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
