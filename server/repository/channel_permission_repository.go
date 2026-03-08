package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ChannelPermissionRepository defines data access for per-channel role permission overrides.
// Each (channel_id, role_id) pair stores allow/deny bitmasks that override the role's base permissions.
type ChannelPermissionRepository interface {
	// GetByChannel returns all overrides for a channel.
	GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)

	// GetByChannelAndRoles returns overrides for specific roles in a channel (for permission resolution).
	GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error)

	// GetByRoles returns ALL channel overrides for the given roles (across all channels).
	// Used for bulk permission resolution when filtering channel lists (avoids N+1).
	GetByRoles(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error)

	// Set creates or updates an override for a (channel_id, role_id) pair (UPSERT).
	Set(ctx context.Context, override *models.ChannelPermissionOverride) error

	Delete(ctx context.Context, channelID, roleID string) error

	// DeleteAllByChannel removes all overrides for a channel.
	DeleteAllByChannel(ctx context.Context, channelID string) error
}
