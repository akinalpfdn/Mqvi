package models

import (
	"fmt"
	"strings"
	"time"
)

// E2EEKeyBackup, sunucuda saklanan sifreli anahtar yedegini temsil eder.
//
// Kullanici opsiyonel olarak bir "recovery password" belirleyebilir.
// Bu password'den PBKDF2 ile bir AES-256-GCM anahtari turetilir (client-side).
// Tum E2EE anahtarlari (identity key, signed prekeys, Signal sessions,
// Sender Key sessions, guvenilen kimlikler) bu anahtarla sifrelenir.
//
// Sunucu sadece sifreli blob'u saklar — recovery password'u bilmez,
// anahtarlari okuyamaz. Yeni bir cihazda kullanici recovery password
// girerse tum anahtar gecmisi geri yuklenir ve eski mesajlar okunabilir.
type E2EEKeyBackup struct {
	ID            string    `json:"id"`
	UserID        string    `json:"user_id"`
	Version       int       `json:"version"`
	Algorithm     string    `json:"algorithm"`
	EncryptedData string    `json:"encrypted_data"`
	Nonce         string    `json:"nonce"`
	Salt          string    `json:"salt"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// CreateKeyBackupRequest, anahtar yedegi olusturma/guncelleme istegi.
type CreateKeyBackupRequest struct {
	Version       int    `json:"version"`
	Algorithm     string `json:"algorithm"`
	EncryptedData string `json:"encrypted_data"`
	Nonce         string `json:"nonce"`
	Salt          string `json:"salt"`
}

// Validate, CreateKeyBackupRequest zorunlu alanlari kontrol eder.
func (r *CreateKeyBackupRequest) Validate() error {
	if strings.TrimSpace(r.EncryptedData) == "" {
		return fmt.Errorf("encrypted_data is required")
	}
	if strings.TrimSpace(r.Nonce) == "" {
		return fmt.Errorf("nonce is required")
	}
	if strings.TrimSpace(r.Salt) == "" {
		return fmt.Errorf("salt is required")
	}
	if r.Algorithm == "" {
		r.Algorithm = "aes-256-gcm"
	}
	return nil
}

// ChannelGroupSession, bir kanaldaki Sender Key oturumunu temsil eder.
//
// Sender Key (Signal'in grup sifreleme protokolu):
// - Her gonderici cihaz, kanal icin bir "outbound session" olusturur
// - Bu session'in anahtari (SenderKeyDistributionMessage) kanal uyelerine
//   Signal 1:1 sessions uzerinden dagitilir
// - Alicilar "inbound session" olarak kaydeder
// - Sonraki mesajlar tek bir groupEncrypt() ile sifrelenir
// - Tum uyeler ayni ciphertext'i kendi inbound key'leri ile cozer
//
// session_data: Opaque blob — sunucu icerigi bilmez
// message_index: Son bilinen mesaj indexi (rotasyon karari icin)
type ChannelGroupSession struct {
	ID             string    `json:"id"`
	ChannelID      string    `json:"channel_id"`
	SenderUserID   string    `json:"sender_user_id"`
	SenderDeviceID string    `json:"sender_device_id"`
	SessionID      string    `json:"session_id"`
	SessionData    string    `json:"session_data"`
	MessageIndex   int       `json:"message_index"`
	CreatedAt      time.Time `json:"created_at"`
}

// CreateGroupSessionRequest, yeni grup oturumu olusturma istegi.
type CreateGroupSessionRequest struct {
	SessionID   string `json:"session_id"`
	SessionData string `json:"session_data"`
}

// Validate, CreateGroupSessionRequest zorunlu alanlari kontrol eder.
func (r *CreateGroupSessionRequest) Validate() error {
	if strings.TrimSpace(r.SessionID) == "" {
		return fmt.Errorf("session_id is required")
	}
	if strings.TrimSpace(r.SessionData) == "" {
		return fmt.Errorf("session_data is required")
	}
	return nil
}

// EncryptedMessagePayload, E2EE mesaj gondermek icin ek alanlar.
//
// Handler katmaninda JSON body'den parse edilir ve service'e aktarilir.
// Content alani yerine ciphertext tasir. Server icerigini ASLA goremez.
//
// Mentions: Sifrelenmemis mention listesi — sunucunun bildirim ve unread
// badge icin kimin bahsedildigini bilmesi gerekir. Bu bilinçli bir
// privacy trade-off'tur: sunucu "A kullanicisi B'yi mentiond etti" bilir
// ama mesaj icerigini BILMEZ. Signal da ayni yaklasimi kullanir.
type EncryptedMessagePayload struct {
	EncryptionVersion int               `json:"encryption_version"`
	SenderDeviceID    string            `json:"sender_device_id"`
	Ciphertext        string            `json:"ciphertext,omitempty"`
	Ciphertexts       map[string]string `json:"ciphertexts,omitempty"`
	E2EEMetadata      string            `json:"e2ee_metadata,omitempty"`
	Mentions          []string          `json:"mentions,omitempty"`
}
