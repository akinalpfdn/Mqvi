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
	GetLeastLoadedPlatformInstance(ctx context.Context) (*models.LiveKitInstance, error)
	IncrementServerCount(ctx context.Context, instanceID string) error
	DecrementServerCount(ctx context.Context, instanceID string) error
	Update(ctx context.Context, instance *models.LiveKitInstance) error
	Delete(ctx context.Context, id string) error
	ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error)
	// MigrateServers moves all servers from one instance to another. Returns count of migrated servers.
	MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error)
	// MigrateOneServer moves a single server to a new instance (adjusts server_count on both).
	MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error
}
