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
//   - GetMessages: Cursor-based pagination ile mesajları getir (reply + is_pinned dahil)
//   - GetMessageByID: Tek mesaj getir
//   - CreateMessage: Yeni mesaj oluştur (reply_to_id desteği)
//   - UpdateMessage: Mesaj düzenle
//   - DeleteMessage: Mesaj sil
//
// Reaction işlemleri:
//   - ToggleReaction: Emoji tepkisi ekle/kaldır (INSERT OR IGNORE → DELETE toggle pattern)
//   - GetReactionsByMessageID: Tek mesajın reaction'larını gruplanmış getir
//   - GetReactionsByMessageIDs: Birden fazla mesajın reaction'larını batch yükle (N+1 önleme)
//
// Pin işlemleri:
//   - PinMessage: Mesajı sabitle
//   - UnpinMessage: Sabitlemeyi kaldır
//   - GetPinnedMessages: Kanalın sabitlenmiş mesajlarını listele
//
// Attachment işlemleri:
//   - CreateAttachment: Yeni dosya eki kaydet
//   - GetAttachmentsByMessageIDs: Birden fazla mesajın dosya eklerini batch yükle
//
// Arama işlemleri:
//   - SearchMessages: FTS5 tam metin arama
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

	// Reaction operations
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) (added bool, err error)
	GetReactionsByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetReactionsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)

	// Pin operations
	PinMessage(ctx context.Context, messageID string) error
	UnpinMessage(ctx context.Context, messageID string) error
	GetPinnedMessages(ctx context.Context, channelID string) ([]models.DMMessage, error)

	// Attachment operations
	CreateAttachment(ctx context.Context, attachment *models.DMAttachment) error
	GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.DMAttachment, error)

	// Search operations — FTS5 tam metin arama, pagination destekli (limit/offset + total_count)
	SearchMessages(ctx context.Context, channelID string, query string, limit, offset int) ([]models.DMMessage, int, error)
}
