// Package repository — ServerMuteRepository interface.
//
// Kullanıcı bazlı sunucu sessize alma veritabanı işlemleri.
// Expired mute'lar okuma sırasında lazy olarak filtrelenir.
package repository

import "context"

// ServerMuteRepository, server mute veritabanı işlemleri için interface.
type ServerMuteRepository interface {
	// Upsert, sunucu mute'unu ekler veya günceller.
	// mutedUntil nil ise sonsuza kadar sessiz.
	Upsert(ctx context.Context, userID, serverID string, mutedUntil *string) error

	// Delete, sunucu mute'unu kaldırır (unmute).
	Delete(ctx context.Context, userID, serverID string) error

	// GetMutedServerIDs, kullanıcının aktif (expired olmamış) mute'lu sunucu ID'lerini döner.
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}
