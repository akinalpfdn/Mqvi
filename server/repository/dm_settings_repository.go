// Package repository — DMSettingsRepository interface.
// Per-user DM channel settings: hide, pin, mute. Uses UPSERT pattern.
package repository

import (
	"context"
)

// DMSettingsRepository defines data access for per-user DM settings.
type DMSettingsRepository interface {
	// IsHidden checks if the DM is hidden. Used before auto-unhide to avoid unnecessary UPSERT + WS broadcast.
	IsHidden(ctx context.Context, userID, dmChannelID string) (bool, error)

	// SetHidden hides or shows a DM. Hidden DMs auto-unhide on new messages.
	SetHidden(ctx context.Context, userID, dmChannelID string, hidden bool) error

	SetPinned(ctx context.Context, userID, dmChannelID string, pinned bool) error

	// SetMutedUntil mutes a DM. nil mutedUntil means indefinite mute.
	SetMutedUntil(ctx context.Context, userID, dmChannelID string, mutedUntil *string) error

	DeleteMute(ctx context.Context, userID, dmChannelID string) error

	GetPinnedChannelIDs(ctx context.Context, userID string) ([]string, error)

	// GetMutedChannelIDs returns muted DM channel IDs, filtering out expired mutes.
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}
