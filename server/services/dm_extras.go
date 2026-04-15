// Package services — DM reactions, pins, search, and E2EE toggle.
// All paths verify the caller is a channel member before mutating state.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// ─── Reactions ───

func (s *dmService) ToggleReaction(ctx context.Context, userID, messageID, emoji string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	_, err = s.dmRepo.ToggleReaction(ctx, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("failed to toggle DM reaction: %w", err)
	}

	reactions, err := s.dmRepo.GetReactionsByMessageID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get updated reactions: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMReactionUpdate,
		Data: map[string]any{
			"dm_message_id": messageID,
			"dm_channel_id": msg.DMChannelID,
			"reactions":     reactions,
		},
	})

	return nil
}

// ─── Pins ───

func (s *dmService) PinMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if err := s.dmRepo.PinMessage(ctx, messageID); err != nil {
		return fmt.Errorf("failed to pin DM message: %w", err)
	}

	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get updated message: %w", err)
	}
	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessagePin,
		Data: map[string]any{
			"dm_channel_id": msg.DMChannelID,
			"message":       &enriched[0],
		},
	})

	return nil
}

func (s *dmService) UnpinMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if err := s.dmRepo.UnpinMessage(ctx, messageID); err != nil {
		return fmt.Errorf("failed to unpin DM message: %w", err)
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageUnpin,
		Data: map[string]any{
			"dm_channel_id": msg.DMChannelID,
			"message_id":    messageID,
		},
	})

	return nil
}

func (s *dmService) GetPinnedMessages(ctx context.Context, userID, channelID string) ([]models.DMMessage, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetPinnedMessages(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get pinned DM messages: %w", err)
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	return messages, nil
}

// ─── Search ───

func (s *dmService) SearchMessages(ctx context.Context, userID, channelID, query string, limit, offset int) (*models.DMSearchResult, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	if query == "" {
		return &models.DMSearchResult{Messages: []models.DMMessage{}, TotalCount: 0}, nil
	}

	if limit <= 0 || limit > 100 {
		limit = 25
	}
	if offset < 0 {
		offset = 0
	}

	messages, totalCount, err := s.dmRepo.SearchMessages(ctx, channelID, query, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("failed to search DM messages: %w", err)
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	return &models.DMSearchResult{Messages: messages, TotalCount: totalCount}, nil
}

// ─── E2EE Toggle ───

func (s *dmService) ToggleE2EE(ctx context.Context, userID, channelID string, enabled bool) (*models.DMChannel, error) {
	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}

	if err := s.dmRepo.SetE2EEEnabled(ctx, channelID, enabled); err != nil {
		return nil, fmt.Errorf("failed to toggle DM E2EE: %w", err)
	}

	channel.E2EEEnabled = enabled

	s.broadcastToBothUsers(channel, ws.Event{
		Op:   "dm_channel_update",
		Data: channel,
	})

	return channel, nil
}
