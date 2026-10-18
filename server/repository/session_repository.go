package repository

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
)

// SessionRepository defines data access for refresh-token sessions (one row per device).
type SessionRepository interface {
	// Create inserts a session with a caller-chosen ID (the ID is embedded in the refresh token).
	Create(ctx context.Context, session *models.Session) error
	GetByID(ctx context.Context, id string) (*models.Session, error)
	// GetByLegacyToken finds a pre-098 session by its plaintext token, or a converted one by the
	// hash of that token (now its previous token).
	GetByLegacyToken(ctx context.Context, rawToken, tokenHash string) (*models.Session, error)
	// Rotate writes next only if the row still holds the token state the caller read
	// (compare-and-swap on token_hash and legacy_token). false = someone else rotated first.
	Rotate(ctx context.Context, current *models.Session, next models.SessionRotation) (bool, error)
	DeleteByID(ctx context.Context, id string) error
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteExpired(ctx context.Context, now time.Time) (int64, error)
	// ClearPending drops sealed tokens whose grace window ended before cutoff.
	ClearPending(ctx context.Context, cutoff time.Time) (int64, error)
}
