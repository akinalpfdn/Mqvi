package models

import (
	"fmt"
	"time"
)

// ServerMute — MutedUntil nil = muted forever (until manually unmuted).
type ServerMute struct {
	UserID     string     `json:"user_id"`
	ServerID   string     `json:"server_id"`
	MutedUntil *time.Time `json:"muted_until"`
	CreatedAt  time.Time  `json:"created_at"`
}

type MuteServerRequest struct {
	Duration string `json:"duration"` // "1h", "8h", "7d", "forever"
}

var validDurations = map[string]time.Duration{
	"1h":      1 * time.Hour,
	"8h":      8 * time.Hour,
	"7d":      7 * 24 * time.Hour,
	"forever": 0,
}

func (r *MuteServerRequest) Validate() error {
	if _, ok := validDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil converts duration string to *time.Time. "forever" returns nil.
func (r *MuteServerRequest) ParseMutedUntil() *time.Time {
	d := validDurations[r.Duration]
	if d == 0 {
		return nil
	}
	t := time.Now().UTC().Add(d)
	return &t
}
