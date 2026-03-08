package models

import (
	"fmt"
	"time"
)

// MuteForeverSentinel is used as a datetime value that is always in the future.
// SQLite: WHERE muted_until > datetime('now') will always include this.
const MuteForeverSentinel = "9999-12-31T23:59:59Z"

type DMSettings struct {
	UserID      string     `json:"user_id"`
	DMChannelID string     `json:"dm_channel_id"`
	IsHidden    bool       `json:"is_hidden"`
	IsPinned    bool       `json:"is_pinned"`
	MutedUntil  *time.Time `json:"muted_until"` // nil = not muted
	CreatedAt   time.Time  `json:"created_at"`
}

type MuteDMRequest struct {
	Duration string `json:"duration"` // "1h", "8h", "7d", "forever"
}

var validDMDurations = map[string]time.Duration{
	"1h":      1 * time.Hour,
	"8h":      8 * time.Hour,
	"7d":      7 * 24 * time.Hour,
	"forever": 0,
}

func (r *MuteDMRequest) Validate() error {
	if _, ok := validDMDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil converts the duration string to a DB-ready *string.
// "forever" → sentinel, others → now + duration in RFC3339.
func (r *MuteDMRequest) ParseMutedUntil() *string {
	d := validDMDurations[r.Duration]
	if d == 0 {
		s := MuteForeverSentinel
		return &s
	}
	t := time.Now().UTC().Add(d).Format(time.RFC3339)
	return &t
}
