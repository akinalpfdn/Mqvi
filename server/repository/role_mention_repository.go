package repository

import "context"

// RoleMentionRepository stores which roles were @mentioned in a message.
type RoleMentionRepository interface {
	SaveRoleMentions(ctx context.Context, messageID string, roleIDs []string) error
	DeleteByMessageID(ctx context.Context, messageID string) error
	GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error)
}
