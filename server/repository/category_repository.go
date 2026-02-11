package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// CategoryRepository, kategori veritabanı işlemleri için interface.
type CategoryRepository interface {
	Create(ctx context.Context, category *models.Category) error
	GetByID(ctx context.Context, id string) (*models.Category, error)
	GetAll(ctx context.Context) ([]models.Category, error)
	Update(ctx context.Context, category *models.Category) error
	Delete(ctx context.Context, id string) error
	GetMaxPosition(ctx context.Context) (int, error)
}
