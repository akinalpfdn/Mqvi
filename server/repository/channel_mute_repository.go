// Package repository — ChannelMuteRepository interface.
// Per-user channel mute settings. Expired mutes are lazily filtered on read.
package repository

import "context"

// ChannelMuteRepository defines data access for channel mutes.
type ChannelMuteRepository interface {
	// Upsert adds or updates a channel mute. nil mutedUntil means indefinite.
	Upsert(ctx context.Context, userID, channelID, serverID string, mutedUntil *string) error
	Delete(ctx context.Context, userID, channelID string) error
	// GetMutedChannelIDs returns active (non-expired) muted channel IDs.
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}
