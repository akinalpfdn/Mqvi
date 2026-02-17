package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ChannelPermissionRepository, kanal bazlı permission override veritabanı işlemleri.
//
// Her (channel_id, role_id) çifti için bir allow/deny override saklanır.
// Bu override'lar role'un global permission'larını kanal bazında değiştirir.
type ChannelPermissionRepository interface {
	// GetByChannel, bir kanaldaki tüm permission override'ları döner.
	// Admin UI'da kullanılır — "bu kanalda hangi roller için override var?"
	GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)

	// GetByChannelAndRoles, bir kanaldaki belirli rollere ait override'ları döner.
	// Permission resolution'da kullanılır — "bu kullanıcının rolleri için bu kanalda override var mı?"
	GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error)

	// Set, bir (channel_id, role_id) çifti için override oluşturur veya günceller (UPSERT).
	Set(ctx context.Context, override *models.ChannelPermissionOverride) error

	// Delete, bir (channel_id, role_id) çifti için override'ı siler.
	Delete(ctx context.Context, channelID, roleID string) error

	// DeleteAllByChannel, bir kanaldaki tüm override'ları siler.
	// Kanal silindiğinde kullanılır (CASCADE ile de olur ama explicit daha güvenli).
	DeleteAllByChannel(ctx context.Context, channelID string) error
}
