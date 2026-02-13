package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReadStateRepository, okuma durumu veritabanı işlemleri için interface.
//
// Upsert: Son okunan mesajı günceller (yoksa oluşturur).
// GetUnreadCounts: Bir kullanıcının tüm kanallarındaki okunmamış mesaj sayılarını döner.
type ReadStateRepository interface {
	Upsert(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCounts(ctx context.Context, userID string) ([]models.UnreadInfo, error)
}
