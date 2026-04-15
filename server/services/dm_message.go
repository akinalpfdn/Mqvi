// Package services — DM message CRUD.
// Privacy enforcement (block / friends_only / message_request) lives in
// SendMessage; broadcasts are deferred to BroadcastCreate so attachments
// uploaded at the handler layer ship together with the message event.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/ws"
)

func (s *dmService) GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetMessages(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Reverse: DB returns DESC, frontend expects ASC
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}

	return &models.DMMessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// SendMessage creates a DM message. WS broadcast is done via BroadcastCreate after file uploads.
func (s *dmService) SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}

	otherUserID := channel.User1ID
	if channel.User1ID == userID {
		otherUserID = channel.User2ID
	}

	sender, _ := s.userRepo.GetByID(ctx, userID)
	isPlatformAdmin := sender != nil && sender.IsPlatformAdmin

	// Bidirectional block check — platform admins bypass
	if !isPlatformAdmin && s.blockChecker != nil {
		blocked, err := s.blockChecker.IsBlocked(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check block status: %w", err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: cannot send message to blocked user", pkg.ErrForbidden)
		}
	}

	// DM privacy + request enforcement

	if !isPlatformAdmin {
		if channel.Status == models.DMStatusPending {
			// Initiator already sent their 1 message
			if channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
				return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
			}
			// Recipient must accept first
			if channel.InitiatedBy != nil && *channel.InitiatedBy != userID {
				return nil, fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
			}
		}

		// First message on an accepted channel from a non-friend → transition to pending
		if channel.Status == models.DMStatusAccepted && s.friendChecker != nil {
			recipient, _ := s.userRepo.GetByID(ctx, otherUserID)
			if recipient != nil && recipient.DMPrivacy == "message_request" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					msgCount, err := s.dmRepo.CountMessagesBySender(ctx, channelID, userID)
					if err != nil {
						return nil, fmt.Errorf("failed to count messages: %w", err)
					}
					if msgCount == 0 {
						// First message: transition channel to pending
						_ = s.dmRepo.UpdateChannelStatus(ctx, channelID, models.DMStatusPending)
						channel.Status = models.DMStatusPending
						channel.InitiatedBy = &userID
						_ = s.dmRepo.SetInitiatedBy(ctx, channelID, userID)
					} else {
						return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
					}
				}
			}
			// friends_only at send time: block non-friends entirely
			if recipient != nil && recipient.DMPrivacy == "friends_only" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					return nil, fmt.Errorf("%w: this user only accepts messages from friends", pkg.ErrForbidden)
				}
			}
		}
	}

	// Reply validation
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.DMChannelID != channelID {
			return nil, fmt.Errorf("%w: referenced message is not in this DM channel", pkg.ErrBadRequest)
		}
	}

	var contentPtr *string
	if req.Content != "" {
		contentPtr = &req.Content
	}

	msg := &models.DMMessage{
		DMChannelID:       channelID,
		UserID:            userID,
		Content:           contentPtr,
		ReplyToID:         req.ReplyToID,
		EncryptionVersion: req.EncryptionVersion,
		Ciphertext:        req.Ciphertext,
		SenderDeviceID:    req.SenderDeviceID,
		E2EEMetadata:      req.E2EEMetadata,
	}

	if err := s.dmRepo.CreateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("failed to create DM message: %w", err)
	}

	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	author.PasswordHash = ""
	msg.Author = author

	// Load reply reference
	if msg.ReplyToID != nil && *msg.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *msg.ReplyToID)
		if err == nil {
			ref := &models.MessageReference{
				ID:      refMsg.ID,
				Content: refMsg.Content,
			}
			if refMsg.Author != nil {
				refMsg.Author.PasswordHash = ""
				ref.Author = refMsg.Author
			}
			msg.ReferencedMessage = ref
		}
	}

	msg.Attachments = []models.DMAttachment{}
	msg.Reactions = []models.ReactionGroup{}

	// Auto-unhide: if either user hid this DM, show it again on new message (best-effort)
	if s.unhider != nil {
		_ = s.unhider.UnhideForNewMessage(ctx, otherUserID, channelID)
		_ = s.unhider.UnhideForNewMessage(ctx, userID, channelID)
	}

	return msg, nil
}

// BroadcastCreate sends the DM message to both users after file uploads complete.
func (s *dmService) BroadcastCreate(message *models.DMMessage) {
	channel, err := s.dmRepo.GetChannelByID(context.Background(), message.DMChannelID)
	if err != nil {
		return
	}

	event := ws.Event{
		Op:   ws.OpDMMessageCreate,
		Data: message,
	}
	s.broadcastToBothUsers(channel, event)

	// If channel just became pending, notify both users
	if channel.Status == models.DMStatusPending {
		s.broadcastToBothUsers(channel, ws.Event{
			Op: ws.OpDMChannelStatusChange,
			Data: map[string]any{
				"dm_channel_id": channel.ID,
				"status":        channel.Status,
				"initiated_by":  channel.InitiatedBy,
			},
		})
	}
}

func (s *dmService) EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return nil, err
	}

	if msg.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.UpdateMessage(ctx, messageID, req); err != nil {
		return nil, err
	}

	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}

	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return nil, err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op:   ws.OpDMMessageUpdate,
		Data: &enriched[0],
	})

	return &enriched[0], nil
}

func (s *dmService) DeleteMessage(ctx context.Context, userID, messageID string) error {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return err
	}

	if msg.UserID != userID {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.DeleteMessage(ctx, messageID); err != nil {
		return err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageDelete,
		Data: map[string]string{
			"id":            messageID,
			"dm_channel_id": msg.DMChannelID,
		},
	})

	return nil
}
