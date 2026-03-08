package models

import "time"

// Session — JWT refresh token session. Stored in DB so tokens can be
// revoked and all active sessions can be listed per user.
type Session struct {
	ID           string    `json:"id"`
	UserID       string    `json:"user_id"`
	RefreshToken string    `json:"-"`                   // never sent to client
	DeviceID     *string   `json:"device_id,omitempty"` // E2EE device binding
	ExpiresAt    time.Time `json:"expires_at"`
	CreatedAt    time.Time `json:"created_at"`
}
