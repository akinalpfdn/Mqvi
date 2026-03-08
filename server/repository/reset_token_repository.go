package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// PasswordResetRepository defines data access for password reset tokens.
type PasswordResetRepository interface {
	Create(ctx context.Context, token *models.PasswordResetToken) error
	// GetByTokenHash finds a token by its SHA256 hash.
	GetByTokenHash(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error)
	DeleteByID(ctx context.Context, id string) error
	// DeleteByUserID removes all reset tokens for a user (cleanup before creating a new one).
	DeleteByUserID(ctx context.Context, userID string) error
	// DeleteExpired purges expired tokens. Called opportunistically on each reset request.
	DeleteExpired(ctx context.Context) error
	// GetLatestByUserID returns the most recent token for cooldown checks.
	GetLatestByUserID(ctx context.Context, userID string) (*models.PasswordResetToken, error)
}
