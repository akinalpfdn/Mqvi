package services

import (
	"context"
	"fmt"
	"slices"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// ChannelTypingRouter decides who sees a typing indicator in a server channel.
type ChannelTypingRouter struct {
	channels channelServerGetter
	online   ServerOnlineLister
	perms    ChannelPermAudienceResolver
}

func NewChannelTypingRouter(channels channelServerGetter, online ServerOnlineLister, perms ChannelPermAudienceResolver) *ChannelTypingRouter {
	return &ChannelTypingRouter{channels: channels, online: online, perms: perms}
}

// TypingRecipients returns the server's online members who can read channelID, minus the typist —
// or nobody when the typist cannot post there. Failures are returned, never logged: the channel id
// comes straight from a client frame.
func (r *ChannelTypingRouter) TypingRecipients(ctx context.Context, senderUserID, channelID string) ([]string, error) {
	channel, err := r.channels.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("typing in channel %s: %w", channelID, err)
	}
	if channel == nil {
		return nil, fmt.Errorf("typing in channel %s: channel not found", channelID)
	}

	// A typing frame is a claim about a channel; without this anyone holding its id could put their
	// name in its indicator. The cached resolve is enough here: a stale entry shows or hides an
	// indicator for at most its TTL and decides nothing about content.
	senderPerms, err := r.perms.ResolveChannelPermissions(ctx, senderUserID, channelID)
	if err != nil {
		return nil, fmt.Errorf("typing in channel %s: sender permissions: %w", channelID, err)
	}
	if !senderPerms.Has(models.PermViewChannel) || !senderPerms.Has(models.PermSendMessages) {
		return nil, fmt.Errorf("%w: cannot post in channel %s", pkg.ErrForbidden, channelID)
	}

	readers, err := channelAudienceOrErr(ctx, r.online, r.perms, channel.ServerID, channelID, models.PermViewChannel|models.PermReadMessages)
	if err != nil {
		return nil, fmt.Errorf("typing in channel %s: %w", channelID, err)
	}
	return slices.DeleteFunc(readers, func(uid string) bool { return uid == senderUserID }), nil
}
