package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// RoleRepository defines data access for roles. All list operations are server-scoped.
type RoleRepository interface {
	// ─── Read ───
	GetByID(ctx context.Context, id string) (*models.Role, error)
	GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error)
	GetDefaultByServer(ctx context.Context, serverID string) (*models.Role, error)
	GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error)
	// GetByServerGroupedByUser returns every role assignment in one server, keyed by user.
	// One query for a whole roster, instead of GetByUserIDAndServer per member.
	GetByServerGroupedByUser(ctx context.Context, serverID string) (map[string][]models.Role, error)
	GetMaxPosition(ctx context.Context, serverID string) (int, error)

	// ─── Write ───
	Create(ctx context.Context, role *models.Role) error
	Update(ctx context.Context, role *models.Role) error
	Delete(ctx context.Context, id string) error

	// UpdatePositions atomically updates position values for multiple roles.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error

	// ─── User-Role mapping ───
	AssignToUser(ctx context.Context, userID, roleID, serverID string) error
	RemoveFromUser(ctx context.Context, userID, roleID string) error
}
