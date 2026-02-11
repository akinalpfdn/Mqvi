package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// SessionRepository, JWT refresh token oturumları için interface.
type SessionRepository interface {
	Create(ctx context.Context, session *models.Session) error
	GetByRefreshToken(ctx context.Context, token string) (*models.Session, error)
	DeleteByID(ctx context.Context, id string) error
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteExpired(ctx context.Context) error
}
