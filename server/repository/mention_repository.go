package repository

import "context"

// MentionRepository defines data access for message mentions.
// GetByMessageIDs batch-loads mentions for multiple messages (avoids N+1).
type MentionRepository interface {
	SaveMentions(ctx context.Context, messageID string, userIDs []string) error
	DeleteByMessageID(ctx context.Context, messageID string) error
	GetMentionedUserIDs(ctx context.Context, messageID string) ([]string, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error)
}
