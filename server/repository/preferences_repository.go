package repository

import (
	"context"
	"encoding/json"

	"github.com/akinalp/mqvi/models"
)

// PreferencesRepository persists user preferences (opaque JSON blob per user).
type PreferencesRepository interface {
	// Get returns the user's preferences. Returns empty Data ({}) if no row exists.
	Get(ctx context.Context, userID string) (*models.UserPreferences, error)

	// Upsert merges partial JSON into existing preferences (top-level key merge).
	// Creates the row if it doesn't exist.
	Upsert(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error)
}
