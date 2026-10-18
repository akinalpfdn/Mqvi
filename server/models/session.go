package models

import (
	"strings"
	"time"
	"unicode"
)

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
	Client        SessionClient
}

// SessionClient is what the devices screen shows about a session: the last seen values.
type SessionClient struct {
	Platform    *string
	DeviceLabel *string
	IP          *string
	City        *string
	Country     *string
}

// SessionRotation is the state a rotation writes over a session row.
type SessionRotation struct {
	TokenHash     string
	PrevTokenHash *string
	PendingToken  *string
	RotatedAt     time.Time
	ExpiresAt     time.Time
	Client        SessionClient
}

// SessionView is one row of the active-devices list.
type SessionView struct {
	ID          string    `json:"id"`
	Platform    *string   `json:"platform"`
	DeviceLabel *string   `json:"device_label"`
	IP          *string   `json:"ip"`
	City        *string   `json:"city"`
	Country     *string   `json:"country"`
	CreatedAt   time.Time `json:"created_at"`
	LastActive  time.Time `json:"last_active"`
	IsCurrent   bool      `json:"is_current"`
}

// Client platforms a session can report. Anything else is stored as unknown.
var sessionPlatforms = map[string]bool{
	"windows": true, "macos": true, "linux": true, "android": true, "ios": true, "web": true,
}

const maxDeviceLabelRunes = 64

// ClientInfo is what a client says about itself when a session is created or refreshed, plus the
// address the request came from. Client-supplied, so it is normalised, never trusted.
type ClientInfo struct {
	Platform    string
	DeviceLabel string
	IP          string
}

// Normalized drops an unknown platform and trims the label to printable text of bounded length.
func (c ClientInfo) Normalized() ClientInfo {
	if !sessionPlatforms[c.Platform] {
		c.Platform = ""
	}
	label := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(c.DeviceLabel))
	if runes := []rune(label); len(runes) > maxDeviceLabelRunes {
		label = string(runes[:maxDeviceLabelRunes])
	}
	c.DeviceLabel = label
	return c
}
