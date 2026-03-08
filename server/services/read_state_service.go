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
}

type readStateService struct {
	readStateRepo repository.ReadStateRepository
	permResolver  ChannelPermResolver
}

func NewReadStateService(
	readStateRepo repository.ReadStateRepository,
	permResolver ChannelPermResolver,
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

func (s *readStateService) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	all, err := s.readStateRepo.GetUnreadCounts(ctx, userID, serverID)
	if err != nil {
		return nil, err
	}

	// Filter to channels where user has ViewChannel AND ReadMessages
	filtered := make([]models.UnreadInfo, 0, len(all))
	for _, info := range all {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, info.ChannelID)
		if err != nil {
			continue
		}
		if perms.Has(models.PermViewChannel) && perms.Has(models.PermReadMessages) {
			filtered = append(filtered, info)
		}
	}

	return filtered, nil
}
