package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// RoleRepository, rol veritabanı işlemleri için interface.
type RoleRepository interface {
	GetByID(ctx context.Context, id string) (*models.Role, error)
	GetAll(ctx context.Context) ([]models.Role, error)
	GetDefault(ctx context.Context) (*models.Role, error)
	GetByUserID(ctx context.Context, userID string) ([]models.Role, error)
	AssignToUser(ctx context.Context, userID string, roleID string) error
	RemoveFromUser(ctx context.Context, userID string, roleID string) error
}
