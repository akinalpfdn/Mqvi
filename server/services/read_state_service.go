package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// ReadStateService handles unread message tracking.
// GetUnreadCounts is server-scoped — returns unread counts for channels in a given server.
type ReadStateService interface {
	MarkRead(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error)
	MarkAllRead(ctx context.Context, userID, serverID string) error
	MarkMentionSeen(ctx context.Context, userID, channelID, mentionMessageID string) error
}

type readStateService struct {
	readStateRepo repository.ReadStateRepository
	permResolver  UserChannelsPermResolver
}

func NewReadStateService(
	readStateRepo repository.ReadStateRepository,
	permResolver UserChannelsPermResolver,
) ReadStateService {
	return &readStateService{
		readStateRepo: readStateRepo,
		permResolver:  permResolver,
	}
}

func (s *readStateService) MarkRead(ctx context.Context, userID, channelID, messageID string) error {
	if strings.TrimSpace(messageID) == "" {
		return fmt.Errorf("%w: message_id is required", pkg.ErrBadRequest)
	}
	return s.readStateRepo.Upsert(ctx, userID, channelID, messageID)
}

func (s *readStateService) MarkAllRead(ctx context.Context, userID, serverID string) error {
	return s.readStateRepo.MarkAllRead(ctx, userID, serverID)
}

func (s *readStateService) MarkMentionSeen(ctx context.Context, userID, channelID, mentionMessageID string) error {
	if strings.TrimSpace(mentionMessageID) == "" {
		return fmt.Errorf("%w: mention_message_id is required", pkg.ErrBadRequest)
	}
	return s.readStateRepo.SetMentionSeen(ctx, userID, channelID, mentionMessageID)
}

func (s *readStateService) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	all, err := s.readStateRepo.GetUnreadCounts(ctx, userID, serverID)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return all, nil
	}

	// Only channels the user may read: ViewChannel and ReadMessages. A read that fails is an error,
	// not "no permission" — dropping the counts would show a server with nothing unread.
	channelIDs := make([]string, len(all))
	for i, info := range all {
		channelIDs[i] = info.ChannelID
	}
	perms, err := s.permResolver.ResolveUserChannelsPermissions(ctx, userID, serverID, channelIDs)
	if err != nil {
		return nil, fmt.Errorf("resolve unread permissions: %w", err)
	}
	filtered := make([]models.UnreadInfo, 0, len(all))
	for _, info := range all {
		if p := perms[info.ChannelID]; p.Has(models.PermViewChannel) && p.Has(models.PermReadMessages) {
			filtered = append(filtered, info)
		}
	}
	return filtered, nil
}
