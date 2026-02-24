package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// RoleRepository, rol veritabanı işlemleri için interface.
type RoleRepository interface {
	// ─── Read ───
	GetByID(ctx context.Context, id string) (*models.Role, error)
	GetAll(ctx context.Context) ([]models.Role, error)
	GetDefault(ctx context.Context) (*models.Role, error)
	GetByUserID(ctx context.Context, userID string) ([]models.Role, error)
	GetMaxPosition(ctx context.Context) (int, error)

	// ─── Write ───
	Create(ctx context.Context, role *models.Role) error
	Update(ctx context.Context, role *models.Role) error
	Delete(ctx context.Context, id string) error

	// UpdatePositions, birden fazla rolün position değerini atomik olarak günceller.
	// Transaction kullanılır — bir hata olursa tüm değişiklikler geri alınır.
	UpdatePositions(ctx context.Context, items []models.PositionUpdate) error

	// ─── User-Role mapping ───
	AssignToUser(ctx context.Context, userID string, roleID string) error
	RemoveFromUser(ctx context.Context, userID string, roleID string) error
}
