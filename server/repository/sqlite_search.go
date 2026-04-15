package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqliteSearchRepo struct {
	db database.TxQuerier
}

func NewSQLiteSearchRepo(db database.TxQuerier) SearchRepository {
	return &sqliteSearchRepo{db: db}
}

// Search performs FTS5 full-text search with BM25 ranking.
func (r *sqliteSearchRepo) Search(ctx context.Context, query string, serverID string, channelID *string, limit, offset int) (*SearchResult, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	safeQuery := sanitizeFTSQuery(query)
	if safeQuery == "" {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	var countQuery string
	var countArgs []any

	if channelID != nil {
		countQuery = `
			SELECT COUNT(*)
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			JOIN channels ch ON ch.id = m.channel_id
			WHERE messages_fts MATCH ? AND ch.server_id = ? AND m.channel_id = ?`
		countArgs = []any{safeQuery, serverID, *channelID}
	} else {
		countQuery = `
			SELECT COUNT(*)
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			JOIN channels ch ON ch.id = m.channel_id
			WHERE messages_fts MATCH ? AND ch.server_id = ?`
		countArgs = []any{safeQuery, serverID}
	}

	var totalCount int
	if err := r.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&totalCount); err != nil {
		return nil, fmt.Errorf("failed to count search results: %w", err)
	}

	if totalCount == 0 {
		return &SearchResult{Messages: []models.Message{}, TotalCount: 0}, nil
	}

	var dataQuery string
	var dataArgs []any

	if channelID != nil {
		dataQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			JOIN channels ch ON ch.id = m.channel_id
			LEFT JOIN users u ON m.user_id = u.id
			WHERE messages_fts MATCH ? AND ch.server_id = ? AND m.channel_id = ?
			ORDER BY fts.rank
			LIMIT ? OFFSET ?`
		dataArgs = []any{safeQuery, serverID, *channelID, limit, offset}
	} else {
		dataQuery = `
			SELECT m.id, m.channel_id, m.user_id, m.content, m.edited_at, m.created_at,
			       u.id, u.username, u.display_name, u.avatar_url, u.status
			FROM messages_fts fts
			JOIN messages m ON m.rowid = fts.rowid
			JOIN channels ch ON ch.id = m.channel_id
			LEFT JOIN users u ON m.user_id = u.id
			WHERE messages_fts MATCH ? AND ch.server_id = ?
			ORDER BY fts.rank
			LIMIT ? OFFSET ?`
		dataArgs = []any{safeQuery, serverID, limit, offset}
	}

	rows, err := r.db.QueryContext(ctx, dataQuery, dataArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to search messages: %w", err)
	}
	defer rows.Close()

	var messages []models.Message
	for rows.Next() {
		var msg models.Message
		var author models.User
		var authorID sql.NullString

		if err := rows.Scan(
			&msg.ID, &msg.ChannelID, &msg.UserID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&authorID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.Status,
		); err != nil {
			return nil, fmt.Errorf("failed to scan search result row: %w", err)
		}

		if authorID.Valid {
			author.ID = authorID.String
			author.PasswordHash = ""
			msg.Author = &author
		}
		msg.Attachments = []models.Attachment{}

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating search result rows: %w", err)
	}

	if messages == nil {
		messages = []models.Message{}
	}

	return &SearchResult{
		Messages:   messages,
		TotalCount: totalCount,
	}, nil
}

// sanitizeFTSQuery wraps each word in quotes for FTS5 MATCH. With the trigram
// tokenizer (migration 057) each quoted phrase is matched as a substring — no
// prefix wildcard needed. Quoting neutralises FTS5 operators in user input.
// Trigram requires at least 3 characters to match; shorter tokens are dropped.
func sanitizeFTSQuery(query string) string {
	words := strings.Fields(query)
	if len(words) == 0 {
		return ""
	}

	var safe []string
	for _, w := range words {
		cleaned := strings.ReplaceAll(w, "\"", "")
		cleaned = strings.ReplaceAll(cleaned, "*", "")
		if len([]rune(cleaned)) < 3 {
			continue
		}
		safe = append(safe, "\""+cleaned+"\"")
	}

	if len(safe) == 0 {
		return ""
	}

	return strings.Join(safe, " ")
}
