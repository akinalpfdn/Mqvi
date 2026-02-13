// Package repository — InviteRepository interface.
//
// Davet kodları için CRUD soyutlaması.
// Interface Segregation: InviteRepository sadece davet işlemlerini kapsar.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// InviteRepository, davet kodu veritabanı işlemleri için interface.
type InviteRepository interface {
	// GetByCode, belirli bir davet kodunu döner.
	// Bulunamazsa pkg.ErrNotFound döner.
	GetByCode(ctx context.Context, code string) (*models.Invite, error)

	// List, tüm davet kodlarını oluşturan kullanıcı bilgisiyle döner.
	// Sonuçlar created_at DESC sıralıdır (en yeni en üstte).
	List(ctx context.Context) ([]models.InviteWithCreator, error)

	// Create, yeni bir davet kodu oluşturur.
	Create(ctx context.Context, invite *models.Invite) error

	// Delete, bir davet kodunu siler.
	Delete(ctx context.Context, code string) error

	// IncrementUses, davet kodunun kullanım sayısını 1 artırır.
	// Kayıt sırasında çağrılır.
	IncrementUses(ctx context.Context, code string) error
}
