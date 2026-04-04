package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

type DMService interface {
	GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error)
	ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error)

	GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error)
	SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error)
	BroadcastCreate(message *models.DMMessage)
	EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error)
	DeleteMessage(ctx context.Context, userID, messageID string) error

	AcceptRequest(ctx context.Context, userID, channelID string) error
	DeclineRequest(ctx context.Context, userID, channelID string) error
	AcceptPendingChannels(ctx context.Context, userA, userB string) error

	ToggleReaction(ctx context.Context, userID, messageID, emoji string) error
	PinMessage(ctx context.Context, userID, messageID string) error
	UnpinMessage(ctx context.Context, userID, messageID string) error
	GetPinnedMessages(ctx context.Context, userID, channelID string) ([]models.DMMessage, error)
	SearchMessages(ctx context.Context, userID, channelID, query string, limit, offset int) (*models.DMSearchResult, error)
	ToggleE2EE(ctx context.Context, userID, channelID string, enabled bool) (*models.DMChannel, error)
}

// FriendshipChecker is a minimal ISP interface for friend checks (used by dmService).
type FriendshipChecker interface {
	AreFriends(ctx context.Context, userA, userB string) (bool, error)
}

type dmService struct {
	dmRepo        repository.DMRepository
	userRepo      repository.UserRepository
	hub           ws.Broadcaster
	blockChecker  BlockChecker
	friendChecker FriendshipChecker
	unhider       DMSettingsUnhider
}

func NewDMService(
	dmRepo repository.DMRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	blockChecker BlockChecker,
	friendshipChecker FriendshipChecker,
	unhider DMSettingsUnhider,
) DMService {
	return &dmService{
		dmRepo:        dmRepo,
		userRepo:      userRepo,
		hub:           hub,
		blockChecker:  blockChecker,
		friendChecker: friendshipChecker,
		unhider:       unhider,
	}
}

// sortUserIDs ensures consistent ordering for the UNIQUE(user1_id, user2_id) constraint.
func sortUserIDs(a, b string) (string, string) {
	if a < b {
		return a, b
	}
	return b, a
}

func (s *dmService) broadcastToBothUsers(channel *models.DMChannel, event ws.Event) {
	s.hub.BroadcastToUser(channel.User1ID, event)
	if channel.User1ID != channel.User2ID {
		s.hub.BroadcastToUser(channel.User2ID, event)
	}
}

func (s *dmService) verifyChannelMembership(ctx context.Context, userID, channelID string) (*models.DMChannel, error) {
	channel, err := s.dmRepo.GetChannelByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.User1ID != userID && channel.User2ID != userID {
		return nil, fmt.Errorf("%w: not a member of this DM channel", pkg.ErrForbidden)
	}
	return channel, nil
}

func (s *dmService) verifyMessageAccess(ctx context.Context, userID, messageID string) (*models.DMMessage, *models.DMChannel, error) {
	msg, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, nil, err
	}

	channel, err := s.verifyChannelMembership(ctx, userID, msg.DMChannelID)
	if err != nil {
		return nil, nil, err
	}

	return msg, channel, nil
}

// enrichMessages batch-loads attachments and reactions for a message list (avoids N+1).
func (s *dmService) enrichMessages(ctx context.Context, messages []models.DMMessage) error {
	if len(messages) == 0 {
		return nil
	}

	messageIDs := make([]string, len(messages))
	for i, m := range messages {
		messageIDs[i] = m.ID
	}

	attachmentMap, err := s.dmRepo.GetAttachmentsByMessageIDs(ctx, messageIDs)
	if err != nil {
		return fmt.Errorf("failed to batch load DM attachments: %w", err)
	}

	reactionMap, err := s.dmRepo.GetReactionsByMessageIDs(ctx, messageIDs)
	if err != nil {
		return fmt.Errorf("failed to batch load DM reactions: %w", err)
	}

	for i := range messages {
		messages[i].Attachments = attachmentMap[messages[i].ID]
		if messages[i].Attachments == nil {
			messages[i].Attachments = []models.DMAttachment{}
		}
		messages[i].Reactions = reactionMap[messages[i].ID]
		if messages[i].Reactions == nil {
			messages[i].Reactions = []models.ReactionGroup{}
		}
	}

	return nil
}

// ─── Channel Operations ───

func (s *dmService) GetOrCreateChannel(ctx context.Context, userID, otherUserID string) (*models.DMChannelWithUser, error) {
	if userID == otherUserID {
		return nil, fmt.Errorf("%w: cannot create DM with yourself", pkg.ErrBadRequest)
	}

	otherUser, err := s.userRepo.GetByID(ctx, otherUserID)
	if err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	user1, user2 := sortUserIDs(userID, otherUserID)

	existing, err := s.dmRepo.GetChannelByUsers(ctx, user1, user2)
	if err != nil {
		return nil, fmt.Errorf("failed to check existing DM channel: %w", err)
	}

	if existing != nil {
		otherUser.PasswordHash = ""
		return &models.DMChannelWithUser{
			ID:            existing.ID,
			OtherUser:     otherUser,
			Status:        existing.Status,
			InitiatedBy:   existing.InitiatedBy,
			CreatedAt:     existing.CreatedAt,
			LastMessageAt: existing.LastMessageAt,
		}, nil
	}

	// Determine channel status based on friendship
	status := models.DMStatusAccepted
	var initiatedBy *string
	if s.friendChecker != nil {
		friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check friendship: %w", err)
		}
		if !friends {
			status = models.DMStatusPending
			initiatedBy = &userID
		}
	}

	channel := &models.DMChannel{
		User1ID:     user1,
		User2ID:     user2,
		Status:      status,
		InitiatedBy: initiatedBy,
	}
	if err := s.dmRepo.CreateChannel(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create DM channel: %w", err)
	}

	result := &models.DMChannelWithUser{
		ID:            channel.ID,
		OtherUser:     otherUser,
		Status:        channel.Status,
		InitiatedBy:   channel.InitiatedBy,
		CreatedAt:     channel.CreatedAt,
		LastMessageAt: channel.LastMessageAt,
	}

	// Notify both users (each sees the other as the "other user")
	currentUser, err := s.userRepo.GetByID(ctx, userID)
	if err == nil {
		currentUser.PasswordHash = ""
		s.hub.BroadcastToUser(otherUserID, ws.Event{
			Op: ws.OpDMChannelCreate,
			Data: models.DMChannelWithUser{
				ID:            channel.ID,
				OtherUser:     currentUser,
				CreatedAt:     channel.CreatedAt,
				LastMessageAt: channel.LastMessageAt,
			},
		})
	}

	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDMChannelCreate,
		Data: result,
	})

	return result, nil
}

func (s *dmService) ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error) {
	return s.dmRepo.ListChannels(ctx, userID)
}

// ─── Message Operations ───

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

	// Bidirectional block check
	if s.blockChecker != nil {
		otherUserID := channel.User1ID
		if channel.User1ID == userID {
			otherUserID = channel.User2ID
		}
		blocked, err := s.blockChecker.IsBlocked(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check block status: %w", err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: cannot send message to blocked user", pkg.ErrForbidden)
		}
	}

	// DM request enforcement: pending channels allow only 1 message from the initiator
	if channel.Status == models.DMStatusPending && channel.InitiatedBy != nil && *channel.InitiatedBy == userID {
		count, err := s.dmRepo.CountMessagesBySender(ctx, channelID, userID)
		if err != nil {
			return nil, fmt.Errorf("failed to count messages: %w", err)
		}
		if count >= 1 {
			return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
		}
	}

	// Recipient of a pending request cannot send messages until they accept
	if channel.Status == models.DMStatusPending && channel.InitiatedBy != nil && *channel.InitiatedBy != userID {
		return nil, fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
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
		otherUserID := channel.User1ID
		if channel.User1ID == userID {
			otherUserID = channel.User2ID
		}
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

// ─── DM Request Operations ───

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

// ─── Reaction Operations ───

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

// ─── Pin Operations ───

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

// ─── Search Operations ───

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
