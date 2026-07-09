package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ServerRepository defines data access for servers and membership.
type ServerRepository interface {
	// ─── Server CRUD ───

	Create(ctx context.Context, server *models.Server) error
	// GetByID returns the server including soft-deleted state. Use GetActiveByID
	// for member-facing paths where soft-deleted servers must appear as not-found.
	GetByID(ctx context.Context, serverID string) (*models.Server, error)
	// GetActiveByID returns the server only if deleted_at IS NULL.
	GetActiveByID(ctx context.Context, serverID string) (*models.Server, error)
	Update(ctx context.Context, server *models.Server) error
	// SetDiscoveryFlag flips a single admin discovery flag (verified/featured/discovery_blocked).
	// The column is resolved from a whitelist, so `flag` cannot inject SQL.
	SetDiscoveryFlag(ctx context.Context, serverID, flag string, value bool) error
	// Delete removes a server. CASCADE handles all related data.
	Delete(ctx context.Context, serverID string) error
	// SoftDelete marks the server deleted_at = NOW with deleted_by + deleted_by_admin.
	// Member-facing queries treat the server as gone; owner/admin can still see it
	// in their respective restore lists. Worker hard-deletes after 30-day TTL.
	SoftDelete(ctx context.Context, serverID, deletedBy string, byAdmin bool) error
	// Restore clears the soft-delete fields. Returns ErrNotFound if server doesn't exist
	// or wasn't soft-deleted. Caller is responsible for authorization (owner vs admin).
	Restore(ctx context.Context, serverID string) error
	// ListDeletedByOwner returns soft-deleted servers owned by this user.
	ListDeletedByOwner(ctx context.Context, ownerID string) ([]models.Server, error)
	// ListSoftDeletedExpired returns soft-deleted servers whose deleted_at is older than ttlDays.
	// Used by the cleanup worker to identify servers ready for hard-delete.
	ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.Server, error)
	// ListActiveServerIDsByOwner returns IDs of non-soft-deleted servers owned by this user.
	// Used by admin hard-delete to broadcast server_delete to members before cascade.
	ListActiveServerIDsByOwner(ctx context.Context, ownerID string) ([]string, error)

	// ─── Membership ───

	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
	AddMember(ctx context.Context, serverID, userID string) error
	RemoveMember(ctx context.Context, serverID, userID string) error
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
	GetMemberCount(ctx context.Context, serverID string) (int, error)
	// GetMemberUserIDs returns all member user IDs for a server. Used by server
	// restore to broadcast events to members who are not currently subscribed
	// (e.g. they reconnected while the server was soft-deleted, so the server
	// wasn't in their client.serverIDs index).
	GetMemberUserIDs(ctx context.Context, serverID string) ([]string, error)
	// GetMemberServerIDs returns all server IDs a user belongs to (for WS hub client.ServerIDs).
	GetMemberServerIDs(ctx context.Context, userID string) ([]string, error)

	// UpdateMemberPositions updates a user's server ordering. Runs in a transaction.
	UpdateMemberPositions(ctx context.Context, userID string, items []models.PositionUpdate) error

	// GetMaxMemberPosition returns the highest position value for a user (for position = max+1 on join).
	GetMaxMemberPosition(ctx context.Context, userID string) (int, error)

	// ─── Admin ───

	// ListAdminServersPaged returns paginated, filtered, sorted servers with stats and total count.
	// activeVoiceServerIDs overrides last_activity to "now" for servers with currently-in-voice
	// users (DB last_voice_activity stamps only at JOIN). Without it the last_activity sort
	// can drop active servers off page 1 once messaging in other servers overtakes the stamp.
	// Sort/Dir validated against an internal whitelist; invalid values fall back to created_at DESC.
	ListAdminServersPaged(ctx context.Context, params models.AdminListPageParams, activeVoiceServerIDs []string) (models.AdminServerListPage, error)

	UpdateLastVoiceActivity(ctx context.Context, serverID string) error

	// CountOwnedMqviHostedServers returns the number of platform-managed servers owned by a user.
	CountOwnedMqviHostedServers(ctx context.Context, ownerID string) (int, error)
}
