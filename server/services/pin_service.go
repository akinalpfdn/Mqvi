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
	channelRepo  repository.ChannelRepository
	hub          ws.BroadcastAndOnline
	permResolver ChannelPermResolver
	urlSigner    FileURLSigner
}

func NewPinService(
	pinRepo repository.PinRepository,
	messageRepo repository.MessageRepository,
	channelRepo repository.ChannelRepository,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
	urlSigner FileURLSigner,
) PinService {
	return &pinService{
		pinRepo:      pinRepo,
		messageRepo:  messageRepo,
		channelRepo:  channelRepo,
		hub:          hub,
		permResolver: permResolver,
		urlSigner:    urlSigner,
	}
}

// allowedViewers returns online user IDs that have ViewChannel + ReadMessages on the channel.
// Scoped to the channel's server members.
func (s *pinService) allowedViewers(channelID string) []string {
	ctx := context.Background()

	channel, err := s.channelRepo.GetByID(ctx, channelID)
	if err != nil || channel == nil {
		return nil
	}

	onlineUsers := s.hub.GetOnlineUserIDsForServer(channel.ServerID)
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

	s.signPinnedMessage(message)

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
	pins, err := s.pinRepo.GetByChannelID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	for i := range pins {
		s.signPinnedMessage(pins[i].Message)
		if pins[i].PinnedByUser != nil {
			pins[i].PinnedByUser.AvatarURL = s.urlSigner.SignURLPtr(pins[i].PinnedByUser.AvatarURL)
		}
	}
	return pins, nil
}

// signPinnedMessage signs avatar URLs in a message's Author and ReferencedMessage.Author.
func (s *pinService) signPinnedMessage(msg *models.Message) {
	if msg == nil {
		return
	}
	if msg.Author != nil {
		msg.Author.AvatarURL = s.urlSigner.SignURLPtr(msg.Author.AvatarURL)
	}
	if msg.ReferencedMessage != nil && msg.ReferencedMessage.Author != nil {
		msg.ReferencedMessage.Author.AvatarURL = s.urlSigner.SignURLPtr(msg.ReferencedMessage.Author.AvatarURL)
	}
}
