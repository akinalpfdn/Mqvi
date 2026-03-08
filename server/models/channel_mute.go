// Package models — ChannelMute domain model.
// MutedUntil nil = muted forever. Channel mute overrides server unmute state.
package models

import (
	"fmt"
	"time"
)

// ChannelMute represents a user muting a specific channel.
type ChannelMute struct {
	UserID     string     `json:"user_id"`
	ChannelID  string     `json:"channel_id"`
	ServerID   string     `json:"server_id"`
	MutedUntil *time.Time `json:"muted_until"` // nil = forever
	CreatedAt  time.Time  `json:"created_at"`
}

// MuteChannelRequest is the request body for muting a channel.
// Valid durations: "1h", "8h", "7d", "forever". Uses validDurations from server_mute.go.
type MuteChannelRequest struct {
	Duration string `json:"duration"`
}

// Validate checks the duration field.
func (r *MuteChannelRequest) Validate() error {
	if _, ok := validDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil converts duration string to *time.Time. "forever" returns nil.
func (r *MuteChannelRequest) ParseMutedUntil() *time.Time {
	d := validDurations[r.Duration]
	if d == 0 {
		return nil // forever
	}
	t := time.Now().UTC().Add(d)
	return &t
}
