// Package repository — ChannelMuteRepository interface.
//
// Kullanıcı bazlı kanal sessize alma veritabanı işlemleri.
// Expired mute'lar okuma sırasında lazy olarak filtrelenir.
package repository

import "context"

// ChannelMuteRepository, channel mute veritabanı işlemleri için interface.
type ChannelMuteRepository interface {
	// Upsert, kanal mute'unu ekler veya günceller.
	// mutedUntil nil ise sonsuza kadar sessiz.
	Upsert(ctx context.Context, userID, channelID, serverID string, mutedUntil *string) error

	// Delete, kanal mute'unu kaldırır (unmute).
	Delete(ctx context.Context, userID, channelID string) error

	// GetMutedChannelIDs, kullanıcının aktif (expired olmamış) mute'lu kanal ID'lerini döner.
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}
