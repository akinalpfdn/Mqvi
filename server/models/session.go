package models

import "time"

// Session is one signed-in device ("family"). Its ID is the `sid` claim and the prefix of every
// refresh token it issues; the row survives rotation, only the token hashes move.
type Session struct {
	ID            string     `json:"id"`
	UserID        string     `json:"user_id"`
	TokenHash     *string    `json:"-"`                   // sha256 of the current refresh token
	PrevTokenHash *string    `json:"-"`                   // sha256 of the token the current one replaced
	PendingToken  *string    `json:"-"`                   // encrypted current token, answered to repeats inside the grace window
	LegacyToken   *string    `json:"-"`                   // pre-098 plaintext token; nil once rotated
	DeviceID      *string    `json:"device_id,omitempty"` // E2EE device binding
	RotatedAt     *time.Time `json:"rotated_at,omitempty"`
	ExpiresAt     time.Time  `json:"expires_at"`
	CreatedAt     time.Time  `json:"created_at"`
}

// SessionRotation is the state a rotation writes over a session row.
type SessionRotation struct {
	TokenHash     string
	PrevTokenHash *string
	PendingToken  *string
	RotatedAt     time.Time
	ExpiresAt     time.Time
}
