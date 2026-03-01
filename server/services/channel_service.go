package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// ChannelVisibilityChecker, kanal görünürlük filtreleme ISP interface'i.
// serverID parametresi ile kullanıcının o sunucudaki rolleri alınır.
type ChannelVisibilityChecker interface {
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

// ChannelVisibilityFilter, kullanıcı bazlı kanal görünürlük hesaplama sonucu.
type ChannelVisibilityFilter struct {
	IsAdmin         bool
	HasBaseView     bool
	HiddenChannels  map[string]bool
	GrantedChannels map[string]bool
}

func (f *ChannelVisibilityFilter) CanSee(channelID string) bool {
	if f.IsAdmin {
		return true
	}
	if f.HiddenChannels[channelID] {
		return false
	}
	if f.GrantedChannels[channelID] {
		return true
	}
	return f.HasBaseView
}

// ChannelService, kanal iş mantığı interface'i.
// Tüm list operasyonları server-scoped.
type ChannelService interface {
	GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error)
	Create(ctx context.Context, serverID string, req *models.CreateChannelRequest) (*models.Channel, error)
	Update(ctx context.Context, id string, req *models.UpdateChannelRequest) (*models.Channel, error)
	Delete(ctx context.Context, id string) error
	ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error)
}

type channelService struct {
	channelRepo  repository.ChannelRepository
	categoryRepo repository.CategoryRepository
	hub          ws.Broadcaster
	visChecker   ChannelVisibilityChecker
}

func NewChannelService(
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	hub ws.Broadcaster,
	visChecker ChannelVisibilityChecker,
) ChannelService {
	return &channelService{
		channelRepo:  channelRepo,
		categoryRepo: categoryRepo,
		hub:          hub,
		visChecker:   visChecker,
	}
}

func (s *channelService) GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error) {
	categories, err := s.categoryRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories: %w", err)
	}

	channels, err := s.channelRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels: %w", err)
	}

	filter, err := s.visChecker.BuildVisibilityFilter(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to build visibility filter: %w", err)
	}

	channelsByCategory := make(map[string][]models.Channel)
	for _, ch := range channels {
		if !filter.CanSee(ch.ID) {
			continue
		}
		catID := ""
		if ch.CategoryID != nil {
			catID = *ch.CategoryID
		}
		channelsByCategory[catID] = append(channelsByCategory[catID], ch)
	}

	result := make([]models.CategoryWithChannels, 0, len(categories))
	for _, cat := range categories {
		chs := channelsByCategory[cat.ID]
		if len(chs) == 0 && !filter.IsAdmin {
			continue
		}
		if chs == nil {
			chs = []models.Channel{}
		}
		result = append(result, models.CategoryWithChannels{
			Category: cat,
			Channels: chs,
		})
	}

	return result, nil
}

func (s *channelService) Create(ctx context.Context, serverID string, req *models.CreateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if req.CategoryID != "" {
		if _, err := s.categoryRepo.GetByID(ctx, req.CategoryID); err != nil {
			return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
		}
	}

	maxPos, err := s.channelRepo.GetMaxPosition(ctx, req.CategoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	channel := &models.Channel{
		ServerID: serverID,
		Name:     req.Name,
		Type:     models.ChannelType(req.Type),
		Position: maxPos + 1,
	}

	if req.CategoryID != "" {
		channel.CategoryID = &req.CategoryID
	}
	if req.Topic != "" {
		channel.Topic = &req.Topic
	}
	if channel.Type == models.ChannelTypeVoice {
		channel.Bitrate = 64000
	}

	if err := s.channelRepo.Create(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelCreate,
		Data: nil,
	})

	return channel, nil
}

func (s *channelService) Update(ctx context.Context, id string, req *models.UpdateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.channelRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if req.Name != nil {
		channel.Name = *req.Name
	}
	if req.Topic != nil {
		channel.Topic = req.Topic
	}

	if err := s.channelRepo.Update(ctx, channel); err != nil {
		return nil, err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelUpdate,
		Data: channel,
	})

	return channel, nil
}

func (s *channelService) Delete(ctx context.Context, id string) error {
	if err := s.channelRepo.Delete(ctx, id); err != nil {
		return err
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelDelete,
		Data: map[string]string{"id": id},
	})

	return nil
}

func (s *channelService) ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.channelRepo.UpdatePositions(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update channel positions: %w", err)
	}

	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelReorder,
		Data: nil,
	})

	grouped, err := s.GetAllGrouped(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload channels after reorder: %w", err)
	}

	return grouped, nil
}
