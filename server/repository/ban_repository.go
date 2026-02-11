package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// BanRepository, ban (yasaklama) veritabanı işlemleri için interface.
//
// Interface Segregation: Bu interface sadece ban ile ilgili operasyonları tanımlar.
// UserRepository'ye eklemek yerine ayrı tutuyoruz çünkü:
// 1. Ban ve User farklı domain'ler — sorumlulukları ayrı
// 2. Ban kontrolü farklı yerlerde yapılır (login, WS connect)
// 3. Test'te sadece ban davranışını mock'lamak kolaylaşır
type BanRepository interface {
	// Create, yeni bir ban kaydı oluşturur.
	Create(ctx context.Context, ban *models.Ban) error

	// GetByUserID, belirli bir kullanıcının ban kaydını döner.
	GetByUserID(ctx context.Context, userID string) (*models.Ban, error)

	// GetAll, tüm ban kayıtlarını döner.
	GetAll(ctx context.Context) ([]models.Ban, error)

	// Delete, bir ban kaydını siler (unban).
	Delete(ctx context.Context, userID string) error

	// Exists, kullanıcının banlı olup olmadığını kontrol eder.
	// GetByUserID'den farkı: sadece boolean döner, tüm kaydı yüklemez.
	Exists(ctx context.Context, userID string) (bool, error)
}
