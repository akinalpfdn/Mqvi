package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
)

type sqliteRoleMentionRepo struct {
	db database.TxQuerier
}

func NewSQLiteRoleMentionRepo(db database.TxQuerier) RoleMentionRepository {
	return &sqliteRoleMentionRepo{db: db}
}

func (r *sqliteRoleMentionRepo) SaveRoleMentions(ctx context.Context, messageID string, roleIDs []string) error {
	if len(roleIDs) == 0 {
		return nil
	}

	placeholders := make([]string, len(roleIDs))
	args := make([]interface{}, 0, len(roleIDs)*2)
	for i, rid := range roleIDs {
		placeholders[i] = "(?, ?)"
		args = append(args, messageID, rid)
	}

	query := fmt.Sprintf(
		"INSERT OR IGNORE INTO message_role_mentions (message_id, role_id) VALUES %s",
		strings.Join(placeholders, ", "),
	)

	_, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("failed to save role mentions: %w", err)
	}
	return nil
}

func (r *sqliteRoleMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM message_role_mentions WHERE message_id = ?", messageID)
	if err != nil {
		return fmt.Errorf("failed to delete role mentions: %w", err)
	}
	return nil
}

// GetByMessageIDs batch-loads role mentions. Returns map[messageID][]roleID.
func (r *sqliteRoleMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
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
		"SELECT message_id, role_id FROM message_role_mentions WHERE message_id IN (%s)",
		strings.Join(placeholders, ", "),
	)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to batch get role mentions: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]string)
	for rows.Next() {
		var messageID, roleID string
		if err := rows.Scan(&messageID, &roleID); err != nil {
			return nil, fmt.Errorf("failed to scan role mention: %w", err)
		}
		result[messageID] = append(result[messageID], roleID)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating role mentions: %w", err)
	}

	return result, nil
}
