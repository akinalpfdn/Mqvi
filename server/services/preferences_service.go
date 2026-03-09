package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// PreferencesService manages user preferences (opaque JSON blob).
type PreferencesService interface {
	Get(ctx context.Context, userID string) (*models.UserPreferences, error)
	Update(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error)
}

type preferencesService struct {
	repo repository.PreferencesRepository
}

// NewPreferencesService creates a new PreferencesService.
func NewPreferencesService(repo repository.PreferencesRepository) PreferencesService {
	return &preferencesService{repo: repo}
}

func (s *preferencesService) Get(ctx context.Context, userID string) (*models.UserPreferences, error) {
	prefs, err := s.repo.Get(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get preferences: %w", err)
	}
	return prefs, nil
}

func (s *preferencesService) Update(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error) {
	prefs, err := s.repo.Upsert(ctx, userID, partial)
	if err != nil {
		return nil, fmt.Errorf("update preferences: %w", err)
	}
	return prefs, nil
}
