package services

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MaxEmojiLength caps emoji string length. Most emojis are 1-2 codepoints but
// compound emojis (family, flag) can exceed 10. 32 provides a safe margin.
const MaxEmojiLength = 32

type ReactionService interface {
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) error
}

type reactionService struct {
	reactionRepo repository.ReactionRepository
	messageRepo  repository.MessageRepository
	hub          ws.Broadcaster
}

func NewReactionService(
	reactionRepo repository.ReactionRepository,
	messageRepo repository.MessageRepository,
	hub ws.Broadcaster,
) ReactionService {
	return &reactionService{
		reactionRepo: reactionRepo,
		messageRepo:  messageRepo,
		hub:          hub,
	}
}

// ToggleReaction adds or removes an emoji reaction on a message.
// Same endpoint toggles: call again to remove.
func (s *reactionService) ToggleReaction(ctx context.Context, messageID, userID, emoji string) error {
	if emoji == "" {
		return fmt.Errorf("%w: emoji is required", pkg.ErrBadRequest)
	}
	if utf8.RuneCountInString(emoji) > MaxEmojiLength {
		return fmt.Errorf("%w: emoji too long", pkg.ErrBadRequest)
	}

	// Verify message exists (also need channel_id for broadcast)
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}

	added, err := s.reactionRepo.Toggle(ctx, messageID, userID, emoji)
	if err != nil {
		return fmt.Errorf("failed to toggle reaction: %w", err)
	}

	reactions, err := s.reactionRepo.GetByMessageID(ctx, messageID)
	if err != nil {
		return fmt.Errorf("failed to get reactions after toggle: %w", err)
	}

	// Broadcast includes actor_id and message_author_id so frontend can
	// determine unread state ("someone reacted to my message").
	s.hub.BroadcastToAll(ws.Event{
		Op: ws.OpReactionUpdate,
		Data: map[string]any{
			"message_id":        messageID,
			"channel_id":        message.ChannelID,
			"reactions":         reactions,
			"actor_id":          userID,
			"message_author_id": message.UserID,
			"added":             added,
		},
	})

	return nil
}
