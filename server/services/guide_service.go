package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
)

// GuideService serves the onboarding guide: which steps are done, and whether it is hidden.
type GuideService interface {
	GetState(ctx context.Context, userID string) (*models.GuideState, error)
	SetHidden(ctx context.Context, userID string, hidden bool) (*models.GuideState, error)
	MarkAppUsed(ctx context.Context, userID string) (*models.GuideState, error)
}

type guideService struct {
	repo repository.GuideRepository
}

func NewGuideService(repo repository.GuideRepository) GuideService {
	return &guideService{repo: repo}
}

func (s *guideService) GetState(ctx context.Context, userID string) (*models.GuideState, error) {
	state, err := s.repo.GetState(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get guide: %w", err)
	}
	return state, nil
}

func (s *guideService) MarkAppUsed(ctx context.Context, userID string) (*models.GuideState, error) {
	if err := s.repo.MarkAppUsed(ctx, userID); err != nil {
		return nil, fmt.Errorf("mark app used: %w", err)
	}
	return s.GetState(ctx, userID)
}

// SetHidden returns the state as stored after the write, not as the caller assumed it.
func (s *guideService) SetHidden(ctx context.Context, userID string, hidden bool) (*models.GuideState, error) {
	if err := s.repo.SetHidden(ctx, userID, hidden); err != nil {
		return nil, fmt.Errorf("set guide hidden: %w", err)
	}
	return s.GetState(ctx, userID)
}
