package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// InviteRepository defines data access for invite codes. All list operations are server-scoped.
type InviteRepository interface {
	GetByCode(ctx context.Context, code string) (*models.Invite, error)
	ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)
	Create(ctx context.Context, invite *models.Invite) error
	Delete(ctx context.Context, code string) error
	// IncrementUses atomically consumes one use while a slot remains. Returns ErrConflict
	// when no slot is left (max_uses reached), so callers must resolve the code first.
	IncrementUses(ctx context.Context, code string) error
}
