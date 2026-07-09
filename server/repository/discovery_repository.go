package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// DiscoveryRepository serves the public server directory. It reads only public preview data
// (is_public, non-deleted servers) and never exposes private members/channels/settings.
type DiscoveryRepository interface {
	// ListPublicServers returns a filtered, paginated page of public servers.
	ListPublicServers(ctx context.Context, params models.PublicServerListParams) (models.PublicServerListPage, error)
	// GetPublicServerItem returns a single public server's card, or ErrNotFound if it is not
	// public / is deleted.
	GetPublicServerItem(ctx context.Context, serverID, requestingUserID string) (*models.PublicServerListItem, error)
}
