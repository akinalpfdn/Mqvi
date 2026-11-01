package services

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ServerOnlineLister lists the online members of a server. Implemented by the WS hub.
type ServerOnlineLister interface {
	GetOnlineUserIDsForServer(serverID string) []string
}

// channelAudience returns the server's online members whose effective permissions in channelID
// include every bit of required. A resolve error drops that user: an event withheld is safe, an
// event leaked is not.
func channelAudience(
	ctx context.Context,
	online ServerOnlineLister,
	resolver ChannelPermResolver,
	serverID, channelID string,
	required models.Permission,
) []string {
	users := online.GetOnlineUserIDsForServer(serverID)
	out := make([]string, 0, len(users))
	for _, uid := range users {
		perms, err := resolver.ResolveChannelPermissions(ctx, uid, channelID)
		if err != nil {
			continue
		}
		if perms&required == required || perms.Has(models.PermAdmin) {
			out = append(out, uid)
		}
	}
	return out
}
