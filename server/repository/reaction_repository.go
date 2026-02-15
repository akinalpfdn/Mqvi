package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReactionRepository, emoji reaction veritabanı işlemleri için interface.
//
// Toggle: Bir reaction'ı ekler veya kaldırır (toggle pattern).
//   - UNIQUE(message_id, user_id, emoji) constraint sayesinde aynı reaction
//     zaten varsa INSERT başarısız olur → DELETE yapılır.
//   - added=true: Yeni reaction eklendi, added=false: Mevcut reaction kaldırıldı.
//
// GetByMessageID: Tek bir mesajın reaction'larını gruplanmış (emoji + count + users) döner.
//
// GetByMessageIDs: Birden fazla mesajın reaction'larını batch olarak yükler.
//   - N+1 problemini önler: 50 mesaj için 50 ayrı sorgu yerine tek sorgu.
//   - Return: map[messageID] → []ReactionGroup
type ReactionRepository interface {
	Toggle(ctx context.Context, messageID, userID, emoji string) (added bool, err error)
	GetByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)
}
