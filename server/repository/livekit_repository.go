package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// LiveKitRepository defines data access for LiveKit SFU instances and server mappings.
type LiveKitRepository interface {
	Create(ctx context.Context, instance *models.LiveKitInstance) error
	GetByID(ctx context.Context, id string) (*models.LiveKitInstance, error)
	// GetByServerID returns the LiveKit instance linked to a server (JOIN on servers.livekit_instance_id).
	GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error)
	// GetLeastLoadedPlatformInstance returns the platform-managed instance with fewest servers (load balancing).
	// preferRegion is a preference, not a filter: instances elsewhere stay eligible, they just
	// sort after. An empty preference reduces to plain least-loaded, which is the pre-region behaviour.
	GetLeastLoadedPlatformInstance(ctx context.Context, preferRegion string) (*models.LiveKitInstance, error)

	// Channel→instance bindings. Written when a channel claims an instance and deleted when it
	// empties, so the table only holds calls in progress. Persisted purely so a restart does not
	// forget where a running call lives and send the next joiner somewhere else.
	GetChannelBinding(ctx context.Context, channelID string) (string, error)
	SetChannelBinding(ctx context.Context, channelID, instanceID string) error
	ClearChannelBinding(ctx context.Context, channelID string) error
	IncrementServerCount(ctx context.Context, instanceID string) error
	DecrementServerCount(ctx context.Context, instanceID string) error
	Update(ctx context.Context, instance *models.LiveKitInstance) error
	Delete(ctx context.Context, id string) error
	ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error)
	// ListAllInstances returns all LiveKit instances (both platform-managed and self-hosted).
	// Used by webhook handler to verify HMAC signatures from any known instance.
	ListAllInstances(ctx context.Context) ([]models.LiveKitInstance, error)
	// MigrateServers moves all servers from one instance to another. Returns count of migrated servers.
	MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error)
	// MigrateOneServer moves a single server to a new instance (adjusts server_count on both).
	MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error
}
