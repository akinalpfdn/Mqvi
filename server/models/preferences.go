package models

import (
	"encoding/json"
	"fmt"
)

// UserPreferences holds all client-synced settings as a flexible JSON blob.
// New keys can be added on the frontend without backend migration.
// The backend treats `Data` as opaque JSON — no field-level validation.
type UserPreferences struct {
	UserID    string          `json:"user_id"`
	Data      json.RawMessage `json:"data"`
	UpdatedAt string          `json:"updated_at"`
}

// UpdatePreferencesRequest is the PATCH request body.
// It accepts a partial JSON object that is merged with existing data.
type UpdatePreferencesRequest struct {
	// Partial JSON object — keys present are merged, missing keys are untouched.
	Data json.RawMessage `json:"data"`
}

// Validate checks that data is a valid JSON object (not array, string, etc.).
func (r *UpdatePreferencesRequest) Validate() error {
	if len(r.Data) == 0 {
		return fmt.Errorf("data is required")
	}

	// Must be a JSON object (starts with '{')
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(r.Data, &obj); err != nil {
		return fmt.Errorf("data must be a JSON object")
	}

	return nil
}
