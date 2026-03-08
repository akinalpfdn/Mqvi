package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReactionRepository defines data access for emoji reactions.
//
// Toggle adds or removes a reaction (UNIQUE constraint-based toggle).
// GetByMessageIDs batch-loads reactions for multiple messages (avoids N+1).
type ReactionRepository interface {
	Toggle(ctx context.Context, messageID, userID, emoji string) (added bool, err error)
	GetByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)
}
