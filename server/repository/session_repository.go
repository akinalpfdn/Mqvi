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
	// ListByUser returns the user's sessions, most recently used first.
	ListByUser(ctx context.Context, userID string) ([]models.Session, error)
	// DeleteForUser deletes a session only if it belongs to userID. false = no such session.
	DeleteForUser(ctx context.Context, id, userID string) (bool, error)
	// DeleteOthersForUser deletes every session of userID except keepID and returns their IDs.
	DeleteOthersForUser(ctx context.Context, userID, keepID string) ([]string, error)
	DeleteByID(ctx context.Context, id string) error
	DeleteByUserID(ctx context.Context, userID string) error
	DeleteExpired(ctx context.Context, now time.Time) (int64, error)
	// ClearPending drops encrypted pending tokens whose grace window ended before cutoff.
	ClearPending(ctx context.Context, cutoff time.Time) (int64, error)
}
