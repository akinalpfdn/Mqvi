package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// DeviceRepository, E2EE cihaz kayıt ve prekey yönetimi için interface.
//
// Signal Protocol'de her cihaz bağımsız bir kriptografik kimliğe sahiptir.
// Bu repository cihaz CRUD'u, prekey bundle çekme ve tek kullanımlık
// prekey havuzu yönetimini sağlar.
//
// Prekey havuzu önemlidir: X3DH key agreement sırasında her yeni session
// bir one-time prekey tüketir. Havuz azaldığında sunucu client'a
// "prekey_low" WS event'i gönderir — client yeni prekey'ler yükler.
type DeviceRepository interface {
	// Register, yeni bir cihaz kaydı oluşturur.
	// Aynı (user_id, device_id) çifti varsa günceller (UPSERT).
	Register(ctx context.Context, device *models.Device) error

	// GetByUserAndDevice, belirli bir kullanıcının belirli cihazını döner.
	GetByUserAndDevice(ctx context.Context, userID, deviceID string) (*models.Device, error)

	// ListByUser, kullanıcının tüm kayıtlı cihazlarını döner.
	ListByUser(ctx context.Context, userID string) ([]models.Device, error)

	// ListPublicByUser, başka kullanıcıların görebileceği cihaz bilgilerini döner.
	// Private key veya signature gibi hassas veriler dahil edilmez.
	ListPublicByUser(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)

	// Delete, bir cihaz kaydını ve ilişkili tüm prekey'leri siler.
	// CASCADE sayesinde device_one_time_prekeys'teki kayıtlar da silinir.
	Delete(ctx context.Context, userID, deviceID string) error

	// UpdateSignedPrekey, cihazın signed prekey'ini günceller (rotasyon).
	// Signal Protocol periyodik signed prekey rotasyonu önerir.
	UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error

	// UpdateLastSeen, cihazın son görülme zamanını günceller.
	UpdateLastSeen(ctx context.Context, userID, deviceID string) error

	// --- One-Time Prekey işlemleri ---

	// UploadPrekeys, cihaz için yeni one-time prekey'ler yükler.
	// Mevcut prekey'lerle çakışan prekey_id'ler görmezden gelinir (INSERT OR IGNORE).
	UploadPrekeys(ctx context.Context, userID, deviceID string, prekeys []models.OTPKey) error

	// ConsumePrekey, bir cihazın en eski one-time prekey'ini tüketir (atomik DELETE + RETURNING).
	// X3DH key agreement sırasında çağrılır. Havuz boşsa nil döner.
	ConsumePrekey(ctx context.Context, userID, deviceID string) (*models.OneTimePrekey, error)

	// CountPrekeys, cihazın kalan one-time prekey sayısını döner.
	// Havuz azaldığında client'a "prekey_low" bildirimi gönderilir.
	CountPrekeys(ctx context.Context, userID, deviceID string) (int, error)

	// GetPrekeyBundle, X3DH key agreement için tam prekey bundle'ı döner.
	// Bundle: identity_key + signed_prekey + signed_prekey_signature + (opsiyonel) one_time_prekey.
	// one_time_prekey varsa tüketilir (tek kullanımlık).
	GetPrekeyBundle(ctx context.Context, userID, deviceID string) (*models.PrekeyBundle, error)

	// GetPrekeyBundles, kullanıcının TÜM cihazlarının prekey bundle'larını döner.
	// İlk mesaj gönderilirken alıcının her cihazı için ayrı şifreleme yapılır.
	GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
}
