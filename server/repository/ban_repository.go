package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// BanRepository, ban (yasaklama) veritabanı işlemleri için interface.
// Tüm operasyonlar server-scoped: serverID parametresi zorunlu.
type BanRepository interface {
	// Create, yeni bir ban kaydı oluşturur.
	Create(ctx context.Context, ban *models.Ban) error

	// GetByUserID, belirli bir sunucuda belirli bir kullanıcının ban kaydını döner.
	GetByUserID(ctx context.Context, serverID, userID string) (*models.Ban, error)

	// GetAllByServer, bir sunucudaki tüm ban kayıtlarını döner.
	GetAllByServer(ctx context.Context, serverID string) ([]models.Ban, error)

	// Delete, bir ban kaydını siler (unban).
	Delete(ctx context.Context, serverID, userID string) error

	// Exists, kullanıcının belirli bir sunucuda banlı olup olmadığını kontrol eder.
	Exists(ctx context.Context, serverID, userID string) (bool, error)
}
