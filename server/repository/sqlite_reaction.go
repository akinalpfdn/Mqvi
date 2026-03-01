package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

// sqliteReactionRepo, ReactionRepository interface'inin SQLite implementasyonu.
type sqliteReactionRepo struct {
	db database.TxQuerier
}

// NewSQLiteReactionRepo, constructor — interface döner.
func NewSQLiteReactionRepo(db database.TxQuerier) ReactionRepository {
	return &sqliteReactionRepo{db: db}
}

// Toggle, bir reaction'ı ekler veya kaldırır.
//
// Strateji: INSERT OR IGNORE ile eklemeyi dene.
// rowsAffected == 0 → UNIQUE constraint nedeniyle eklenmedi → zaten var → DELETE yap.
// rowsAffected == 1 → başarıyla eklendi.
//
// Bu pattern, iki ayrı SELECT + INSERT/DELETE yerine tek bir atomik işlem sağlar.
// Race condition riski yoktur çünkü UNIQUE constraint DB seviyesinde korunur.
func (r *sqliteReactionRepo) Toggle(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	insertQuery := `
		INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?)`

	result, err := r.db.ExecContext(ctx, insertQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle reaction insert: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("toggle reaction rows affected: %w", err)
	}

	// INSERT başarılı — yeni reaction eklendi
	if rowsAffected > 0 {
		return true, nil
	}

	// INSERT başarısız (UNIQUE constraint) — reaction zaten var, sil
	deleteQuery := `DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`
	_, err = r.db.ExecContext(ctx, deleteQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle reaction delete: %w", err)
	}

	return false, nil
}

// GetByMessageID, tek bir mesajın reaction'larını gruplanmış olarak döner.
//
// GROUP BY emoji ile aynı emojileri birleştirir.
// GROUP_CONCAT(user_id) ile tepki veren kullanıcı ID'lerini virgülle ayırır.
// COUNT(*) ile her emojinin toplam sayısını hesaplar.
//
// Sonuç ReactionGroup dizisi: [{emoji: "👍", count: 3, users: ["u1","u2","u3"]}]
func (r *sqliteReactionRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error) {
	query := `
		SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM reactions
		WHERE message_id = ?
		GROUP BY emoji
		ORDER BY MIN(created_at) ASC`

	rows, err := r.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("get reactions by message: %w", err)
	}
	defer rows.Close()

	return scanReactionGroups(rows)
}

// GetByMessageIDs, birden fazla mesajın reaction'larını batch olarak yükler.
//
// N+1 problemi çözümü: 50 mesaj varsa 50 ayrı sorgu yerine
// WHERE message_id IN (?, ?, ...) ile tek sorgu yapılır.
//
// Return: map[messageID] → []ReactionGroup
// Reaction'ı olmayan mesajlar map'te key olarak bulunmaz.
func (r *sqliteReactionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	if len(messageIDs) == 0 {
		return make(map[string][]models.ReactionGroup), nil
	}

	// Dinamik placeholder oluştur: (?, ?, ?, ...)
	placeholders := make([]string, len(messageIDs))
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT message_id, emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
		FROM reactions
		WHERE message_id IN (%s)
		GROUP BY message_id, emoji
		ORDER BY message_id, MIN(created_at) ASC`,
		strings.Join(placeholders, ","))

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("get reactions by message ids: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]models.ReactionGroup)
	for rows.Next() {
		var messageID, emoji, usersStr string
		var count int
		if err := rows.Scan(&messageID, &emoji, &count, &usersStr); err != nil {
			return nil, fmt.Errorf("scan reaction group: %w", err)
		}

		users := strings.Split(usersStr, ",")
		result[messageID] = append(result[messageID], models.ReactionGroup{
			Emoji: emoji,
			Count: count,
			Users: users,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reaction rows: %w", err)
	}

	return result, nil
}

// scanReactionGroups, reaction GROUP BY sorgusunun sonuçlarını parse eder.
func scanReactionGroups(rows *sql.Rows) ([]models.ReactionGroup, error) {
	var groups []models.ReactionGroup
	for rows.Next() {
		var emoji, usersStr string
		var count int
		if err := rows.Scan(&emoji, &count, &usersStr); err != nil {
			return nil, fmt.Errorf("scan reaction group: %w", err)
		}

		users := strings.Split(usersStr, ",")
		groups = append(groups, models.ReactionGroup{
			Emoji: emoji,
			Count: count,
			Users: users,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reaction rows: %w", err)
	}

	if groups == nil {
		groups = []models.ReactionGroup{}
	}

	return groups, nil
}
