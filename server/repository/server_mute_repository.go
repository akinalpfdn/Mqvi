// Package repository — ServerMuteRepository interface.
// Per-user server mute settings. Expired mutes are lazily filtered on read.
package repository

import "context"

// ServerMuteRepository defines data access for server mutes.
type ServerMuteRepository interface {
	// Upsert adds or updates a server mute. nil mutedUntil means indefinite.
	Upsert(ctx context.Context, userID, serverID string, mutedUntil *string) error
	Delete(ctx context.Context, userID, serverID string) error
	// GetMutedServerIDs returns active (non-expired) muted server IDs.
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}
