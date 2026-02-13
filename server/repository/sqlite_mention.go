package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// sqliteMentionRepo, MentionRepository interface'inin SQLite implementasyonu.
type sqliteMentionRepo struct {
	db *sql.DB
}

// NewSQLiteMentionRepo, constructor — interface döner.
func NewSQLiteMentionRepo(db *sql.DB) MentionRepository {
	return &sqliteMentionRepo{db: db}
}

// SaveMentions, bir mesajdaki tüm mention'ları batch INSERT ile kaydeder.
//
// INSERT OR IGNORE kullanır — aynı (message_id, user_id) çifti zaten varsa skip eder.
// Bu, aynı kullanıcı birden fazla kez bahsedildiğinde duplicate hatasını önler.
//
// Neden batch INSERT?
// Her mention için ayrı INSERT yapmak yerine tek sorguda hepsini eklemek çok daha verimli.
// SQLite'ın multi-row INSERT desteğini kullanıyoruz:
// INSERT INTO ... VALUES (?, ?), (?, ?), (?, ?)
func (r *sqliteMentionRepo) SaveMentions(ctx context.Context, messageID string, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}

	// Multi-row INSERT oluştur
	placeholders := make([]string, len(userIDs))
	args := make([]interface{}, 0, len(userIDs)*2)
	for i, uid := range userIDs {
		placeholders[i] = "(?, ?)"
		args = append(args, messageID, uid)
	}

	query := fmt.Sprintf(
		"INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES %s",
		strings.Join(placeholders, ", "),
	)

	_, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to save mentions: %w", err)
	}
	return nil
}

// DeleteByMessageID, bir mesajın tüm mention kayıtlarını siler.
// Mesaj düzenlendiğinde mevcut mention'lar silinip yenileri eklenir.
func (r *sqliteMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM message_mentions WHERE message_id = ?", messageID)
	if err != nil {
		return fmt.Errorf("failed to delete mentions: %w", err)
	}
	return nil
}

// GetMentionedUserIDs, bir mesajda bahsedilen kullanıcı ID'lerini döner.
func (r *sqliteMentionRepo) GetMentionedUserIDs(ctx context.Context, messageID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT user_id FROM message_mentions WHERE message_id = ?", messageID)
	if err != nil {
		return nil, fmt.Errorf("failed to get mentions: %w", err)
	}
	defer rows.Close()

	var userIDs []string
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, fmt.Errorf("failed to scan mention: %w", err)
		}
		userIDs = append(userIDs, uid)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating mentions: %w", err)
	}

	if userIDs == nil {
		userIDs = []string{}
	}
	return userIDs, nil
}

// GetByMessageIDs, birden fazla mesajın mention'larını batch olarak döner.
//
// N+1 problemi önleme:
// Her mesaj için ayrı sorgu yapmak yerine tek sorguda tüm mention'ları çeker.
// Sonuç: map[messageID][]userID formatında döner.
func (r *sqliteMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]string), nil
	}

	placeholders := make([]string, len(messageIDs))
	args := make([]interface{}, len(messageIDs))
	for i, id := range messageIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(
		"SELECT message_id, user_id FROM message_mentions WHERE message_id IN (%s)",
		strings.Join(placeholders, ", "),
	)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to batch get mentions: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]string)
	for rows.Next() {
		var messageID, userID string
		if err := rows.Scan(&messageID, &userID); err != nil {
			return nil, fmt.Errorf("failed to scan mention: %w", err)
		}
		result[messageID] = append(result[messageID], userID)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating batch mentions: %w", err)
	}

	return result, nil
}
