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
	// Delete removes an invite by code, scoped to serverID (IDOR guard). A code belonging
	// to another server matches 0 rows → ErrNotFound.
	Delete(ctx context.Context, serverID, code string) error
	// IncrementUses atomically consumes one use while a slot remains. Returns ErrConflict
	// when no slot is left (max_uses reached), so callers must resolve the code first.
	IncrementUses(ctx context.Context, code string) error
	// DecrementUses gives back one use (compensation for a post-consume join failure).
	// Best-effort: guarded by uses > 0, 0 rows is a no-op, not an error.
	DecrementUses(ctx context.Context, code string) error
}
