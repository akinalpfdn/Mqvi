package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// E2EEKeyBackupRepository, şifreli anahtar yedekleri için interface.
//
// Kullanıcı opsiyonel bir recovery password belirleyebilir.
// Bu password'den PBKDF2 ile AES-256-GCM anahtarı türetilir (client-side).
// Tüm E2EE anahtarları bu anahtarla şifrelenir ve sunucuya yüklenir.
//
// Sunucu sadece şifreli blob'u saklar — recovery password'ü bilmez,
// anahtarları okuyamaz. Yeni bir cihazda kullanıcı recovery password
// girerse tüm anahtar geçmişi geri yüklenir.
type E2EEKeyBackupRepository interface {
	// Upsert, anahtar yedeğini oluşturur veya günceller.
	// Her kullanıcının tek bir backup'ı olabilir (UNIQUE user_id).
	Upsert(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error

	// GetByUser, kullanıcının anahtar yedeğini döner. Yoksa nil döner.
	GetByUser(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)

	// Delete, kullanıcının anahtar yedeğini siler.
	Delete(ctx context.Context, userID string) error
}
