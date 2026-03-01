package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// CategoryService, kategori iş mantığı interface'i.
// Tüm list operasyonları server-scoped.
type CategoryService interface {
	GetAllByServer(ctx context.Context, serverID string) ([]models.Category, error)
	Create(ctx context.Context, serverID string, req *models.CreateCategoryRequest) (*models.Category, error)
	Update(ctx context.Context, id string, req *models.UpdateCategoryRequest) (*models.Category, error)
	Delete(ctx context.Context, id string) error
}

type categoryService struct {
	categoryRepo repository.CategoryRepository
	hub          ws.Broadcaster
}

func NewCategoryService(
	categoryRepo repository.CategoryRepository,
	hub ws.Broadcaster,
) CategoryService {
	return &categoryService{
		categoryRepo: categoryRepo,
		hub:          hub,
	}
}

func (s *categoryService) GetAllByServer(ctx context.Context, serverID string) ([]models.Category, error) {
	return s.categoryRepo.GetAllByServer(ctx, serverID)
}

func (s *categoryService) Create(ctx context.Context, serverID string, req *models.CreateCategoryRequest) (*models.Category, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	maxPos, err := s.categoryRepo.GetMaxPosition(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	category := &models.Category{
		ServerID: serverID,
		Name:     req.Name,
		Position: maxPos + 1,
	}

	if err := s.categoryRepo.Create(ctx, category); err != nil {
		return nil, fmt.Errorf("failed to create category: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpCategoryCreate,
		Data: category,
	})

	return category, nil
}

func (s *categoryService) Update(ctx context.Context, id string, req *models.UpdateCategoryRequest) (*models.Category, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	category, err := s.categoryRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if req.Name != nil {
		category.Name = *req.Name
	}

	if err := s.categoryRepo.Update(ctx, category); err != nil {
		return nil, err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpCategoryUpdate,
		Data: category,
	})

	return category, nil
}

func (s *categoryService) Delete(ctx context.Context, id string) error {
	if err := s.categoryRepo.Delete(ctx, id); err != nil {
		return err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpCategoryDelete,
		Data: map[string]string{"id": id},
	})

	return nil
}
