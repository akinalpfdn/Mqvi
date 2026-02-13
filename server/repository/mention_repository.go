package repository

import "context"

// MentionRepository, mesaj mention veritabanı işlemleri için interface.
//
// SaveMentions: Bir mesajdaki tüm mention'ları batch olarak kaydeder.
// DeleteByMessageID: Bir mesajın mention'larını siler (mesaj düzenlenirken).
// GetMentionedUserIDs: Bir mesajda bahsedilen kullanıcı ID'lerini döner.
// GetByMessageIDs: Birden fazla mesajın mention'larını batch olarak döner (N+1 önleme).
type MentionRepository interface {
	SaveMentions(ctx context.Context, messageID string, userIDs []string) error
	DeleteByMessageID(ctx context.Context, messageID string) error
	GetMentionedUserIDs(ctx context.Context, messageID string) ([]string, error)
	GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error)
}
