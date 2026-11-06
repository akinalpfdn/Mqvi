package services

import (
	"context"
	"fmt"
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

// ChannelPermAudienceResolver is a single-user permission check plus the batched audience filter:
// what a service needs that both gates an action and broadcasts its event.
type ChannelPermAudienceResolver interface {
	ChannelPermResolver
	ChannelAudienceFilter
}

// channelServerGetter reads a channel's server for its audience.
type channelServerGetter interface {
	GetByID(ctx context.Context, id string) (*models.Channel, error)
}

// readersOf is the audience of a message event: the channel's server's online members who hold
// ViewChannel and ReadMessages there. A channel that cannot be read withholds the event, logged —
// guessing whom to tell is how a hidden channel's messages leak.
func readersOf(channels channelServerGetter, online ServerOnlineLister, filter ChannelAudienceFilter, channelID string) []string {
	ctx := context.Background()
	channel, err := channels.GetByID(ctx, channelID)
	if err != nil || channel == nil {
		log.Printf("[ws] audience for channel=%s: channel not read: %v (event withheld)", channelID, err)
		return nil
	}
	return channelAudience(ctx, online, filter, channel.ServerID, channelID, models.PermViewChannel|models.PermReadMessages)
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
	audience, err := channelAudienceOrErr(ctx, online, filter, serverID, channelID, required)
	if err != nil {
		log.Printf("[ws] audience for channel=%s: %v (event withheld)", channelID, err)
		return nil
	}
	return audience
}

// channelAudienceOrErr is channelAudience for a caller whose safe answer to a failed read is not
// "nobody".
func channelAudienceOrErr(
	ctx context.Context,
	online ServerOnlineLister,
	filter ChannelAudienceFilter,
	serverID, channelID string,
	required models.Permission,
) ([]string, error) {
	if online == nil || filter == nil {
		return nil, fmt.Errorf("audience for channel %s: no source", channelID)
	}
	users := online.GetOnlineUserIDsForServer(serverID)
	if len(users) == 0 {
		return nil, nil
	}
	audience, err := filter.FilterUsersWithPermission(ctx, channelID, users, required)
	if err != nil {
		return nil, fmt.Errorf("audience for channel %s: %w", channelID, err)
	}
	return audience, nil
}
