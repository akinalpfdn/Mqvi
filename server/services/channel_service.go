package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
)

// ChannelService, kanal iş mantığı interface'i.
type ChannelService interface {
	GetAllGrouped(ctx context.Context) ([]models.CategoryWithChannels, error)
	Create(ctx context.Context, req *models.CreateChannelRequest) (*models.Channel, error)
	Update(ctx context.Context, id string, req *models.UpdateChannelRequest) (*models.Channel, error)
	Delete(ctx context.Context, id string) error
	// ReorderChannels, kanalların sırasını toplu olarak günceller.
	// Transaction ile atomik — ya hepsi güncellenir ya hiçbiri.
	// Başarılıysa güncel CategoryWithChannels listesini WS ile broadcast eder.
	ReorderChannels(ctx context.Context, req *models.ReorderChannelsRequest) ([]models.CategoryWithChannels, error)
}

// channelService, ChannelService'in implementasyonu.
// Tüm dependency'ler interface olarak tutulur (Dependency Inversion).
type channelService struct {
	channelRepo  repository.ChannelRepository
	categoryRepo repository.CategoryRepository
	hub          ws.EventPublisher
}

// NewChannelService, constructor — interface döner.
func NewChannelService(
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	hub ws.EventPublisher,
) ChannelService {
	return &channelService{
		channelRepo:  channelRepo,
		categoryRepo: categoryRepo,
		hub:          hub,
	}
}

// GetAllGrouped, tüm kanalları kategorilere göre gruplanmış olarak döner.
// Frontend sidebar'da bu yapıyı kullanarak collapsible kategori listeleri oluşturur.
func (s *channelService) GetAllGrouped(ctx context.Context) ([]models.CategoryWithChannels, error) {
	categories, err := s.categoryRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories: %w", err)
	}

	channels, err := s.channelRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels: %w", err)
	}

	// Kanalları category_id'ye göre grupla
	channelsByCategory := make(map[string][]models.Channel)
	for _, ch := range channels {
		catID := ""
		if ch.CategoryID != nil {
			catID = *ch.CategoryID
		}
		channelsByCategory[catID] = append(channelsByCategory[catID], ch)
	}

	// Kategorileri kanallarıyla eşleştir
	result := make([]models.CategoryWithChannels, 0, len(categories))
	for _, cat := range categories {
		cwc := models.CategoryWithChannels{
			Category: cat,
			Channels: channelsByCategory[cat.ID],
		}
		if cwc.Channels == nil {
			cwc.Channels = []models.Channel{} // null yerine boş dizi — frontend parsing kolaylığı
		}
		result = append(result, cwc)
	}

	return result, nil
}

// Create, yeni bir kanal oluşturur ve tüm bağlı kullanıcılara bildirir.
func (s *channelService) Create(ctx context.Context, req *models.CreateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Kategori var mı kontrol et
	if req.CategoryID != "" {
		if _, err := s.categoryRepo.GetByID(ctx, req.CategoryID); err != nil {
			return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
		}
	}

	// Position: kategorideki en yüksek position + 1
	maxPos, err := s.channelRepo.GetMaxPosition(ctx, req.CategoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	channel := &models.Channel{
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

	// Varsayılan değerler (voice kanallar için)
	if channel.Type == models.ChannelTypeVoice {
		channel.Bitrate = 64000
	}

	if err := s.channelRepo.Create(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}

	// WebSocket broadcast — tüm bağlı kullanıcılar yeni kanalı görür
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelCreate,
		Data: channel,
	})

	return channel, nil
}

// Update, mevcut bir kanalı günceller.
func (s *channelService) Update(ctx context.Context, id string, req *models.UpdateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.channelRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Sadece gelen alanları güncelle (partial update pattern)
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

// Delete, bir kanalı siler.
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

// ReorderChannels, kanalların sırasını toplu olarak günceller.
//
// Akış:
// 1. Validation — items boş olmamalı, ID'ler benzersiz ve position >= 0
// 2. Repository'ye ilet — transaction ile atomic güncelleme
// 3. Güncel CategoryWithChannels listesini DB'den yeniden yükle
// 4. WS broadcast — tüm client'lar güncel sırayı alır
func (s *channelService) ReorderChannels(ctx context.Context, req *models.ReorderChannelsRequest) ([]models.CategoryWithChannels, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.channelRepo.UpdatePositions(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update channel positions: %w", err)
	}

	// Güncel listeyi DB'den yeniden yükle (position değerleri değişti)
	grouped, err := s.GetAllGrouped(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to reload channels after reorder: %w", err)
	}

	// WS broadcast — tüm client'lar güncel CategoryWithChannels listesini alır
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelReorder,
		Data: grouped,
	})

	return grouped, nil
}
