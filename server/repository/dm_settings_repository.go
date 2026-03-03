// Package repository — DMSettingsRepository interface.
//
// Kullanıcı bazlı DM kanalı ayarları: gizleme, sabitleme, sessize alma.
// UPSERT pattern: İlk etkileşimde satır oluşturulur, sonrakilerde güncellenir.
package repository

import (
	"context"
)

// DMSettingsRepository, kullanıcı DM ayarları veritabanı işlemleri.
type DMSettingsRepository interface {
	// IsHidden, DM'nin gizli olup olmadığını döner.
	// Auto-unhide öncesi kontrol için kullanılır — gereksiz UPSERT + WS broadcast önlenir.
	IsHidden(ctx context.Context, userID, dmChannelID string) (bool, error)

	// SetHidden, DM'yi gizle veya göster.
	// hidden=true ise sidebar'dan gizlenir, yeni mesaj gelince otomatik açılır.
	SetHidden(ctx context.Context, userID, dmChannelID string, hidden bool) error

	// SetPinned, DM'yi sabitle veya sabitlemeyi kaldır.
	SetPinned(ctx context.Context, userID, dmChannelID string, pinned bool) error

	// SetMutedUntil, DM'yi sessize al (muted_until set et).
	// mutedUntil nil ise sonsuz mute.
	SetMutedUntil(ctx context.Context, userID, dmChannelID string, mutedUntil *string) error

	// DeleteMute, DM mute'u kaldır (muted_until = NULL + row silme gerekli değil).
	DeleteMute(ctx context.Context, userID, dmChannelID string) error

	// GetPinnedChannelIDs, kullanıcının sabitlediği DM kanal ID'lerini döner.
	GetPinnedChannelIDs(ctx context.Context, userID string) ([]string, error)

	// GetMutedChannelIDs, kullanıcının sessize aldığı DM kanal ID'lerini döner.
	// Expired mute'lar (muted_until < now) filtrelenir.
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}
