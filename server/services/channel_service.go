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
//
// Interface Segregation Principle: ChannelService sadece görünürlük filtrelemeye
// ihtiyaç duyar, override CRUD veya permission resolution'a değil.
// channelPermService bu interface'i otomatik karşılar (Go duck typing).
type ChannelVisibilityChecker interface {
	BuildVisibilityFilter(ctx context.Context, userID string) (*ChannelVisibilityFilter, error)
}

// ChannelVisibilityFilter, kullanıcı bazlı kanal görünürlük hesaplama sonucu.
//
// ViewChannel yetkisi kanal bazında override edilebilir. Bu struct,
// tüm kanallar için hesaplanmış görünürlük bilgisini tutar.
// CanSee() metodu ile tek bir kanalın görünür olup olmadığı kontrol edilir.
type ChannelVisibilityFilter struct {
	IsAdmin         bool            // Admin tüm kanalları görür (override bypass)
	HasBaseView     bool            // Base permission'da ViewChannel var mı
	HiddenChannels  map[string]bool // Override ile ViewChannel kaldırılan kanallar
	GrantedChannels map[string]bool // Override ile ViewChannel eklenen kanallar (base'de yoksa)
}

// CanSee, bir kanalın kullanıcıya görünür olup olmadığını döner.
//
// Karar sırası:
// 1. Admin → her şeyi görür
// 2. HiddenChannels'da → gizli (base'de var ama override kaldırmış)
// 3. GrantedChannels'da → görünür (base'de yok ama override eklemiş)
// 4. Base'deki ViewChannel → varsayılan
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
type ChannelService interface {
	// GetAllGrouped, kullanıcının görebileceği kanalları kategorilere göre gruplu döner.
	// userID ile ViewChannel yetkisi kontrol edilir — yetkisi olmayan kanallar filtrelenir.
	GetAllGrouped(ctx context.Context, userID string) ([]models.CategoryWithChannels, error)
	Create(ctx context.Context, req *models.CreateChannelRequest) (*models.Channel, error)
	Update(ctx context.Context, id string, req *models.UpdateChannelRequest) (*models.Channel, error)
	Delete(ctx context.Context, id string) error
	// ReorderChannels, kanalların sırasını toplu olarak günceller.
	// userID ile response filtrelenir — çağıran sadece kendi görebildiği kanalları alır.
	ReorderChannels(ctx context.Context, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error)
}

// channelService, ChannelService'in implementasyonu.
// Tüm dependency'ler interface olarak tutulur (Dependency Inversion).
type channelService struct {
	channelRepo  repository.ChannelRepository
	categoryRepo repository.CategoryRepository
	hub          ws.EventPublisher
	visChecker   ChannelVisibilityChecker
}

// NewChannelService, constructor — interface döner.
//
// visChecker: kanal görünürlük filtresi (ChannelPermissionService implement eder).
// channelPermService main.go'da channelService'den ÖNCE oluşturulmalı.
func NewChannelService(
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	hub ws.EventPublisher,
	visChecker ChannelVisibilityChecker,
) ChannelService {
	return &channelService{
		channelRepo:  channelRepo,
		categoryRepo: categoryRepo,
		hub:          hub,
		visChecker:   visChecker,
	}
}

// GetAllGrouped, kullanıcının görebileceği kanalları kategorilere göre gruplu döner.
//
// Akış:
// 1. Tüm kategorileri ve kanalları DB'den çek
// 2. BuildVisibilityFilter ile kullanıcının ViewChannel yetkisini hesapla
// 3. filter.CanSee() ile her kanalı filtrele
// 4. Boş kategorileri çıkar (admin hariç — admin boş kategori görebilir)
func (s *channelService) GetAllGrouped(ctx context.Context, userID string) ([]models.CategoryWithChannels, error) {
	categories, err := s.categoryRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories: %w", err)
	}

	channels, err := s.channelRepo.GetAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels: %w", err)
	}

	// Görünürlük filtresi oluştur
	filter, err := s.visChecker.BuildVisibilityFilter(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to build visibility filter: %w", err)
	}

	// Kanalları category_id'ye göre grupla — sadece görünür olanları
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

	// Kategorileri kanallarıyla eşleştir
	result := make([]models.CategoryWithChannels, 0, len(categories))
	for _, cat := range categories {
		chs := channelsByCategory[cat.ID]

		// Boş kategorileri çıkar — admin boş kategorileri de görebilir
		// (admin yeni kanal oluşturmak için boş kategori görmeli)
		if len(chs) == 0 && !filter.IsAdmin {
			continue
		}

		if chs == nil {
			chs = []models.Channel{} // null yerine boş dizi — frontend parsing kolaylığı
		}

		result = append(result, models.CategoryWithChannels{
			Category: cat,
			Channels: chs,
		})
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

	// WebSocket broadcast — sinyal gönder, client fetchChannels() çağırır.
	// Data nil çünkü yeni kanal bazı kullanıcılar için gizli olabilir —
	// her client kendi visibility'sine göre backend'den fetch eder.
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelCreate,
		Data: nil,
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
// 3. WS broadcast — sinyal gönder (gizli kanal sızıntısını önlemek için data nil)
// 4. Kullanıcının görebileceği güncel listeyi döner
func (s *channelService) ReorderChannels(ctx context.Context, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.channelRepo.UpdatePositions(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update channel positions: %w", err)
	}

	// WS broadcast — sinyal gönder, client fetchChannels() çağırır.
	// Eski pattern tüm kanalları broadcast ediyordu (gizli kanal sızıntısı riski).
	// Artık sadece sinyal gönderilir, her client kendi visibility'sine göre fetch eder.
	s.hub.BroadcastToAll(ws.Event{
		Op:   ws.OpChannelReorder,
		Data: nil,
	})

	// Çağıran kullanıcının görebileceği güncel listeyi döner
	grouped, err := s.GetAllGrouped(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload channels after reorder: %w", err)
	}

	return grouped, nil
}
