// Package services — DM request (message-request flow).
// A channel transitions from accepted → pending when a non-friend sends the
// first message to someone with `message_request` privacy. Only the recipient
// (non-initiator) can accept or decline.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

func (s *dmService) AcceptRequest(ctx context.Context, userID, channelID string) error {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return err
	}

	if channel.Status != models.DMStatusPending {
		return fmt.Errorf("%w: channel is not pending", pkg.ErrBadRequest)
	}

	// Only the recipient (non-initiator) can accept
	if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
		return fmt.Errorf("%w: only the recipient can accept a DM request", pkg.ErrForbidden)
	}

	if err := s.dmRepo.UpdateChannelStatus(ctx, channelID, models.DMStatusAccepted); err != nil {
		return fmt.Errorf("failed to accept DM request: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMRequestAccept,
		Data: map[string]string{
			"dm_channel_id": channelID,
		},
	})

	return nil
}

func (s *dmService) DeclineRequest(ctx context.Context, userID, channelID string) error {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return err
	}

	if channel.Status != models.DMStatusPending {
		return fmt.Errorf("%w: channel is not pending", pkg.ErrBadRequest)
	}

	// Only the recipient can decline
	if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
		return fmt.Errorf("%w: only the recipient can decline a DM request", pkg.ErrForbidden)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMRequestDecline,
		Data: map[string]string{
			"dm_channel_id": channelID,
		},
	})

	if err := s.dmRepo.DeleteChannel(ctx, channelID); err != nil {
		return fmt.Errorf("failed to decline DM request: %w", err)
	}

	return nil
}

// AcceptPendingChannels auto-accepts pending DMs when two users become friends.
func (s *dmService) AcceptPendingChannels(ctx context.Context, userA, userB string) error {
	u1, u2 := sortUserIDs(userA, userB)
	ch, err := s.dmRepo.GetChannelByUsers(ctx, u1, u2)
	if err != nil || ch == nil {
		return nil // no channel exists, nothing to do
	}
	if ch.Status != models.DMStatusPending {
		return nil
	}

	if err := s.dmRepo.UpdateChannelStatus(ctx, ch.ID, models.DMStatusAccepted); err != nil {
		return fmt.Errorf("failed to auto-accept pending DM: %w", err)
	}

	s.broadcastToBothUsers(ch, ws.Event{
		Op: ws.OpDMRequestAccept,
		Data: map[string]string{
			"dm_channel_id": ch.ID,
		},
	})

	return nil
}
