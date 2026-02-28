// Package repository — InviteRepository interface.
//
// Davet kodları için CRUD soyutlaması.
// Tüm list operasyonları server-scoped.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// InviteRepository, davet kodu veritabanı işlemleri için interface.
type InviteRepository interface {
	// GetByCode, belirli bir davet kodunu döner (server_id bilgisi ile).
	GetByCode(ctx context.Context, code string) (*models.Invite, error)

	// ListByServer, belirli bir sunucunun davet kodlarını döner.
	ListByServer(ctx context.Context, serverID string) ([]models.InviteWithCreator, error)

	// Create, yeni bir davet kodu oluşturur.
	Create(ctx context.Context, invite *models.Invite) error

	// Delete, bir davet kodunu siler.
	Delete(ctx context.Context, code string) error

	// IncrementUses, davet kodunun kullanım sayısını 1 artırır.
	IncrementUses(ctx context.Context, code string) error
}
