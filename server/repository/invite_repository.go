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
	IncrementUses(ctx context.Context, code string) error
}
