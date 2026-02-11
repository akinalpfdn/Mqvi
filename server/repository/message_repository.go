package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// MessageRepository, mesaj veritabanı işlemleri için interface.
//
// GetByChannelID cursor-based pagination kullanır:
// beforeID = bu ID'den önceki mesajları getir (boşsa en yenilerden başla).
// limit = kaç mesaj dönsün (default 50).
//
// Neden cursor-based?
// Offset-based pagination'da yeni mesaj geldiğinde sayfa kayar.
// Cursor-based'de "bu mesajdan önceki 50 mesaj" denir — kararlı sonuç verir.
type MessageRepository interface {
	Create(ctx context.Context, message *models.Message) error
	GetByID(ctx context.Context, id string) (*models.Message, error)
	GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	Update(ctx context.Context, message *models.Message) error
	Delete(ctx context.Context, id string) error
}
