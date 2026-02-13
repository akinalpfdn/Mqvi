package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// DMRepository, DM (Direct Messages) veritabanı işlemleri için interface.
//
// Kanal işlemleri:
//   - GetChannelByUsers: İki kullanıcı arasındaki DM kanalını bul
//   - GetChannelByID: ID ile DM kanalı bul
//   - ListChannels: Bir kullanıcının tüm DM kanallarını listele (karşı taraf bilgisiyle)
//   - CreateChannel: Yeni DM kanalı oluştur
//
// Mesaj işlemleri:
//   - GetMessages: Cursor-based pagination ile mesajları getir
//   - GetMessageByID: Tek mesaj getir
//   - CreateMessage: Yeni mesaj oluştur
//   - UpdateMessage: Mesaj düzenle
//   - DeleteMessage: Mesaj sil
type DMRepository interface {
	// Channel operations
	GetChannelByUsers(ctx context.Context, user1ID, user2ID string) (*models.DMChannel, error)
	GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error)
	ListChannels(ctx context.Context, userID string) ([]models.DMChannelWithUser, error)
	CreateChannel(ctx context.Context, channel *models.DMChannel) error

	// Message operations
	GetMessages(ctx context.Context, channelID string, beforeID string, limit int) ([]models.DMMessage, error)
	GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error)
	CreateMessage(ctx context.Context, msg *models.DMMessage) error
	UpdateMessage(ctx context.Context, id string, content string) error
	DeleteMessage(ctx context.Context, id string) error
}
