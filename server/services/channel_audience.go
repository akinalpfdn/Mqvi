package services

import (
	"context"
	"log"

	"github.com/akinalp/mqvi/models"
)

// ServerOnlineLister lists the online members of a server. Implemented by the WS hub.
type ServerOnlineLister interface {
	GetOnlineUserIDsForServer(serverID string) []string
}

// ChannelAudienceFilter keeps the users who hold a permission in a channel: one read for any number
// of users, never the permission cache. Implemented by channelPermService.
type ChannelAudienceFilter interface {
	FilterUsersWithPermission(ctx context.Context, channelID string, userIDs []string, required models.Permission) ([]string, error)
}

// channelAudience returns the server's online members whose effective permissions in channelID
// include every bit of required. It decides who receives an event, so a stale cached grant would be
// a leak; and one read per member made a single event cost thousands of queries on a large server.
// On an error nobody is told: an event withheld is safe, an event leaked is not.
func channelAudience(
	ctx context.Context,
	online ServerOnlineLister,
	filter ChannelAudienceFilter,
	serverID, channelID string,
	required models.Permission,
) []string {
	users := online.GetOnlineUserIDsForServer(serverID)
	if len(users) == 0 {
		return nil
	}
	audience, err := filter.FilterUsersWithPermission(ctx, channelID, users, required)
	if err != nil {
		log.Printf("[ws] audience for channel=%s: %v (event withheld)", channelID, err)
		return nil
	}
	return audience
}
