package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// GuideRepository reads what the onboarding guide needs from the user's own data.
type GuideRepository interface {
	// GetState records any newly completed step before returning; completed steps never revert.
	GetState(ctx context.Context, userID string) (*models.GuideState, error)
	SetHidden(ctx context.Context, userID string, hidden bool) error
}
