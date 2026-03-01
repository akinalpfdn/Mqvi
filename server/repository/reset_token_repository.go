// Package repository — PasswordResetRepository interface tanımı.
//
// Şifre sıfırlama token'larının CRUD işlemlerini soyutlar.
// Service katmanı bu interface'e bağımlıdır, SQLite implementasyonuna değil.
package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// PasswordResetRepository, password reset token veritabanı işlemleri için interface.
type PasswordResetRepository interface {
	// Create, yeni bir reset token kaydı oluşturur.
	Create(ctx context.Context, token *models.PasswordResetToken) error

	// GetByTokenHash, SHA256 hash'e göre token kaydını bulur.
	// Bulunamazsa pkg.ErrNotFound döner.
	GetByTokenHash(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error)

	// DeleteByID, tek bir token kaydını siler (başarılı reset sonrası).
	DeleteByID(ctx context.Context, id string) error

	// DeleteByUserID, bir kullanıcının TÜM reset token'larını siler.
	// Yeni token oluşturmadan önce eskileri temizlemek için.
	DeleteByUserID(ctx context.Context, userID string) error

	// DeleteExpired, süresi dolmuş tüm token'ları temizler.
	// Her reset isteğinde "fırsat temizliği" olarak çağrılır —
	// ayrı bir cron job'a gerek kalmaz.
	DeleteExpired(ctx context.Context) error

	// GetLatestByUserID, kullanıcının en son oluşturulan token'ını döner.
	// Cooldown kontrolü için: son token'ın created_at zamanına bakılır.
	// Token yoksa pkg.ErrNotFound döner.
	GetLatestByUserID(ctx context.Context, userID string) (*models.PasswordResetToken, error)
}
