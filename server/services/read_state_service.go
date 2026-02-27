package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// ReadStateService, okunmamış mesaj takibi iş mantığı interface'i.
//
// MarkRead: Bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
// GetUnreadCounts: Bir kullanıcının tüm kanallarındaki okunmamış mesaj sayılarını döner.
type ReadStateService interface {
	MarkRead(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCounts(ctx context.Context, userID string) ([]models.UnreadInfo, error)
}

type readStateService struct {
	readStateRepo repository.ReadStateRepository
	permResolver  ChannelPermResolver
}

// NewReadStateService, constructor.
//
// permResolver: Kanal bazlı permission çözümleyici. GetUnreadCounts çağrılırken
// kullanıcının PermReadMessages yetkisi olmayan kanalların unread sayıları filtrelenir.
// Bu sayede kullanıcı göremediği kanalların bildirimlerini almaz.
func NewReadStateService(
	readStateRepo repository.ReadStateRepository,
	permResolver ChannelPermResolver,
) ReadStateService {
	return &readStateService{
		readStateRepo: readStateRepo,
		permResolver:  permResolver,
	}
}

// MarkRead, bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
func (s *readStateService) MarkRead(ctx context.Context, userID, channelID, messageID string) error {
	if strings.TrimSpace(messageID) == "" {
		return fmt.Errorf("%w: message_id is required", pkg.ErrBadRequest)
	}
	return s.readStateRepo.Upsert(ctx, userID, channelID, messageID)
}

// GetUnreadCounts, bir kullanıcının tüm kanallarındaki okunmamış mesaj sayılarını döner.
//
// Permission filtresi: Repository tüm text kanalların unread sayısını döner,
// ardından service katmanında her kanal için permission kontrolü yapılır.
//
// İki yetki kontrol edilir:
//   - PermViewChannel: Kanalı sidebar'da görebilme. Bu olmadan kanal kullanıcıya görünmez.
//   - PermReadMessages: Kanal mesajlarını okuyabilme. Bir kanalı görebilen ama
//     okuyamayan kullanıcı (ör. voice-only erişim) için de unread gösterilmemeli.
//
// Her iki yetki de olmalı — yoksa kanal unread listesinden çıkarılır.
func (s *readStateService) GetUnreadCounts(ctx context.Context, userID string) ([]models.UnreadInfo, error) {
	all, err := s.readStateRepo.GetUnreadCounts(ctx, userID)
	if err != nil {
		return nil, err
	}

	// Permission filtresi — ViewChannel AND ReadMessages yetkisi olan kanalları döndür.
	//
	// Has() metodu OR mantığı kullanır (p & mask != 0) — tek bit yeterse true döner.
	// Biz iki yetkinin İKİSİNİN BİRDEN olmasını istiyoruz, bu yüzden ayrı ayrı kontrol.
	filtered := make([]models.UnreadInfo, 0, len(all))
	for _, info := range all {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, info.ChannelID)
		if err != nil {
			continue // Hata durumunda güvenli tarafta kal — dahil etme
		}
		if perms.Has(models.PermViewChannel) && perms.Has(models.PermReadMessages) {
			filtered = append(filtered, info)
		}
	}

	return filtered, nil
}
