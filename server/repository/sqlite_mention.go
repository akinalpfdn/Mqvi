package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
)

type sqliteMentionRepo struct {
	db database.TxQuerier
}

func NewSQLiteMentionRepo(db database.TxQuerier) MentionRepository {
	return &sqliteMentionRepo{db: db}
}

// SaveMentions batch-inserts mentions for a message.
// INSERT OR IGNORE skips duplicates if the same user is mentioned multiple times.
func (r *sqliteMentionRepo) SaveMentions(ctx context.Context, messageID string, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}

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

// DeleteByMessageID removes all mentions for a message. Used before re-inserting on edit.
func (r *sqliteMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM message_mentions WHERE message_id = ?", messageID)
	if err != nil {
		return fmt.Errorf("failed to delete mentions: %w", err)
	}
	return nil
}

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

// GetByMessageIDs batch-loads mentions for multiple messages (avoids N+1).
// Returns map[messageID][]userID.
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
