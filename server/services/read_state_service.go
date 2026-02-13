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
}

// NewReadStateService, constructor.
func NewReadStateService(readStateRepo repository.ReadStateRepository) ReadStateService {
	return &readStateService{readStateRepo: readStateRepo}
}

// MarkRead, bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
func (s *readStateService) MarkRead(ctx context.Context, userID, channelID, messageID string) error {
	if strings.TrimSpace(messageID) == "" {
		return fmt.Errorf("%w: message_id is required", pkg.ErrBadRequest)
	}
	return s.readStateRepo.Upsert(ctx, userID, channelID, messageID)
}

// GetUnreadCounts, bir kullanıcının tüm kanallarındaki okunmamış mesaj sayılarını döner.
func (s *readStateService) GetUnreadCounts(ctx context.Context, userID string) ([]models.UnreadInfo, error) {
	return s.readStateRepo.GetUnreadCounts(ctx, userID)
}
