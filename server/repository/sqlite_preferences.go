package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/akinalp/mqvi/database"
	"github.com/akinalp/mqvi/models"
)

type sqlitePreferencesRepo struct {
	db database.TxQuerier
}

// NewSQLitePreferencesRepo creates a new SQLite-backed PreferencesRepository.
func NewSQLitePreferencesRepo(db database.TxQuerier) PreferencesRepository {
	return &sqlitePreferencesRepo{db: db}
}

func (r *sqlitePreferencesRepo) Get(ctx context.Context, userID string) (*models.UserPreferences, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT user_id, data, updated_at FROM user_preferences WHERE user_id = ?`,
		userID,
	)

	var p models.UserPreferences
	var dataStr string
	err := row.Scan(&p.UserID, &dataStr, &p.UpdatedAt)
	if err != nil {
		// No row — return empty preferences
		return &models.UserPreferences{
			UserID: userID,
			Data:   json.RawMessage(`{}`),
		}, nil
	}
	p.Data = json.RawMessage(dataStr)
	return &p, nil
}

func (r *sqlitePreferencesRepo) Upsert(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error) {
	// 1. Read existing data
	existing, err := r.Get(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get preferences: %w", err)
	}

	// 2. Top-level merge: parse both as map, merge partial into existing
	var base map[string]json.RawMessage
	if err := json.Unmarshal(existing.Data, &base); err != nil {
		base = make(map[string]json.RawMessage)
	}

	var patch map[string]json.RawMessage
	if err := json.Unmarshal(partial, &patch); err != nil {
		return nil, fmt.Errorf("parse partial data: %w", err)
	}

	for k, v := range patch {
		base[k] = v
	}

	merged, err := json.Marshal(base)
	if err != nil {
		return nil, fmt.Errorf("marshal merged preferences: %w", err)
	}

	// 3. Upsert
	_, err = r.db.ExecContext(ctx,
		`INSERT INTO user_preferences (user_id, data, updated_at)
		 VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id) DO UPDATE SET
		   data = ?,
		   updated_at = CURRENT_TIMESTAMP`,
		userID, string(merged), string(merged),
	)
	if err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}

	return r.Get(ctx, userID)
}
