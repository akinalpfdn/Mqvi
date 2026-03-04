package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// GroupSessionRepository, Sender Key grup oturumları için interface.
//
// Sender Key (Signal'in grup şifreleme protokolü) her gönderici cihaz için
// kanala özel bir oturum oluşturur. Oturum anahtarı (SenderKeyDistributionMessage)
// Signal 1:1 sessions üzerinden kanal üyelerine dağıtılır.
//
// Sunucu oturum verilerini opak blob olarak saklar — içeriğini bilmez.
// Bu repository kanal bazında oturum CRUD'u sağlar.
type GroupSessionRepository interface {
	// Upsert, grup oturumunu oluşturur veya günceller.
	// Aynı (channel_id, sender_user_id, sender_device_id, session_id) varsa günceller.
	Upsert(ctx context.Context, channelID, senderUserID, senderDeviceID string, req *models.CreateGroupSessionRequest) error

	// GetByChannel, kanaldaki tüm aktif grup oturumlarını döner.
	// Kanal üyeleri bu oturumları kullanarak mesajları çözer.
	GetByChannel(ctx context.Context, channelID string) ([]models.ChannelGroupSession, error)

	// DeleteByChannel, kanaldaki tüm grup oturumlarını siler.
	// Key rotation sırasında çağrılır — eski oturumlar temizlenir.
	DeleteByChannel(ctx context.Context, channelID string) error

	// DeleteByUser, belirli bir kullanıcının kanaldaki oturumlarını siler.
	// Kullanıcı kanaldan çıkarıldığında çağrılır.
	DeleteByUser(ctx context.Context, channelID, userID string) error
}
