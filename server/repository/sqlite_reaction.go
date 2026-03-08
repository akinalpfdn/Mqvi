package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteReactionRepo struct {
	db database.TxQuerier
}

func NewSQLiteReactionRepo(db database.TxQuerier) ReactionRepository {
	return &sqliteReactionRepo{db: db}
}

// Toggle adds or removes a reaction.
// INSERT OR IGNORE -> rowsAffected == 0 means UNIQUE hit (already exists) -> DELETE.
// Atomic toggle, no race conditions (UNIQUE constraint enforced at DB level).
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

	if rowsAffected > 0 {
		return true, nil // added
	}

	// Already exists -> remove
	deleteQuery := `DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`
	_, err = r.db.ExecContext(ctx, deleteQuery, messageID, userID, emoji)
	if err != nil {
		return false, fmt.Errorf("toggle reaction delete: %w", err)
	}

	return false, nil
}

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

// GetByMessageIDs batch-loads reactions for multiple messages (avoids N+1).
// Messages without reactions won't have a key in the returned map.
func (r *sqliteReactionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
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
