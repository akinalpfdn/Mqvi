package services

import (
	"context"
	"fmt"
	"log"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// MaxPinsPerChannel is the max number of pins per channel (same as Discord: 50).
const MaxPinsPerChannel = 50

type PinService interface {
	Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error)
	Unpin(ctx context.Context, messageID string, channelID string) error
	GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error)
}

type pinService struct {
	pinRepo      repository.PinRepository
	messageRepo  repository.MessageRepository
	hub          ws.BroadcastAndOnline
	permResolver ChannelPermResolver
}

func NewPinService(
	pinRepo repository.PinRepository,
	messageRepo repository.MessageRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
) PinService {
	return &pinService{
		pinRepo:      pinRepo,
		messageRepo:  messageRepo,
		hub:          hub,
		permResolver: permResolver,
	}
}

// allowedViewers returns online user IDs that have ViewChannel + ReadMessages on the channel.
func (s *pinService) allowedViewers(channelID string) []string {
	onlineUsers := s.hub.GetOnlineUserIDs()
	ctx := context.Background()
	var allowed []string
	for _, uid := range onlineUsers {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, uid, channelID)
		if err != nil {
			continue
		}
		if perms.Has(models.PermViewChannel) && perms.Has(models.PermReadMessages) {
			allowed = append(allowed, uid)
		}
	}
	return allowed
}

func (s *pinService) Pin(ctx context.Context, messageID string, channelID string, pinnedBy string) (*models.PinnedMessageWithDetails, error) {
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return nil, err
	}
	if message.ChannelID != channelID {
		return nil, fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	count, err := s.pinRepo.CountByChannelID(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to check pin count: %w", err)
	}
	if count >= MaxPinsPerChannel {
		return nil, fmt.Errorf("%w: channel has reached the maximum number of pins (%d)", pkg.ErrBadRequest, MaxPinsPerChannel)
	}

	pin := &models.PinnedMessage{
		MessageID: messageID,
		ChannelID: channelID,
		PinnedBy:  pinnedBy,
	}
	if err := s.pinRepo.Pin(ctx, pin); err != nil {
		return nil, err
	}

	result := &models.PinnedMessageWithDetails{
		PinnedMessage: *pin,
		Message:       message,
	}

	s.hub.BroadcastToUsers(s.allowedViewers(channelID), ws.Event{
		Op:   ws.OpMessagePin,
		Data: result,
	})
	log.Printf("[pin] message %s pinned in channel %s by user %s", messageID, channelID, pinnedBy)

	return result, nil
}

func (s *pinService) Unpin(ctx context.Context, messageID string, channelID string) error {
	message, err := s.messageRepo.GetByID(ctx, messageID)
	if err != nil {
		return err
	}
	if message.ChannelID != channelID {
		return fmt.Errorf("%w: message does not belong to this channel", pkg.ErrBadRequest)
	}

	if err := s.pinRepo.Unpin(ctx, messageID); err != nil {
		return err
	}

	s.hub.BroadcastToUsers(s.allowedViewers(channelID), ws.Event{
		Op: ws.OpMessageUnpin,
		Data: map[string]string{
			"message_id": messageID,
			"channel_id": channelID,
		},
	})
	log.Printf("[pin] message %s unpinned in channel %s", messageID, channelID)

	return nil
}

func (s *pinService) GetPinnedMessages(ctx context.Context, channelID string) ([]models.PinnedMessageWithDetails, error) {
	return s.pinRepo.GetByChannelID(ctx, channelID)
}
