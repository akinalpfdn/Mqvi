package services

import (
	"context"
	"fmt"
	"slices"

	"github.com/akinalp/mqvi/models"
)

// ChannelTypingRouter decides who sees a typing indicator in a server channel.
type ChannelTypingRouter struct {
	channels channelServerGetter
	online   ServerOnlineLister
	filter   ChannelAudienceFilter
}

func NewChannelTypingRouter(channels channelServerGetter, online ServerOnlineLister, filter ChannelAudienceFilter) *ChannelTypingRouter {
	return &ChannelTypingRouter{channels: channels, online: online, filter: filter}
}

// TypingRecipients returns the server's online members who can read channelID, minus the typist.
// Failures are returned, never logged: the channel id comes straight from a client frame.
func (r *ChannelTypingRouter) TypingRecipients(ctx context.Context, senderUserID, channelID string) ([]string, error) {
	channel, err := r.channels.GetByID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("typing in channel %s: %w", channelID, err)
	}
	if channel == nil {
		return nil, fmt.Errorf("typing in channel %s: channel not found", channelID)
	}
	readers, err := channelAudienceOrErr(ctx, r.online, r.filter, channel.ServerID, channelID, models.PermViewChannel|models.PermReadMessages)
	if err != nil {
		return nil, fmt.Errorf("typing in channel %s: %w", channelID, err)
	}
	return slices.DeleteFunc(readers, func(uid string) bool { return uid == senderUserID }), nil
}
