// Package services — DMService interface, struct, construction, and shared helpers.
//
// Method implementations are split across concern-based files in this package:
//   dm_channel.go — GetOrCreateChannel, ListChannels
//   dm_message.go — GetMessages, SendMessage, BroadcastCreate, EditMessage, DeleteMessage
//   dm_request.go — AcceptRequest, DeclineRequest, AcceptPendingChannels
//   dm_extras.go  — ToggleReaction, pins, search, ToggleE2EE
//
// Unlike voice_service, dmService holds no in-memory state — all operations go
// through the repository layer, so the split is purely organizational.
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

// ─── Shared Helpers ───

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
