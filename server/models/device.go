package models

import (
	"fmt"
	"strings"
	"time"
)

// Device, bir kullanicinin E2EE kayitli cihazini temsil eder.
//
// Signal Protocol'de her cihaz bagimsiz bir kriptografik kimlige sahiptir.
// Ayni kullanicinin telefonu ve bilgisayari farkli identity key'lere sahiptir.
// Mesaj gonderirken alicinin HER cihazi icin ayri sifreleme yapilir.
//
// identity_key: Curve25519 public key — cihazin uzun omurlu kimligi
// signed_prekey: Curve25519 public key — orta vadeli, identity_key ile imzali
// signed_prekey_signature: Ed25519 imza — signed_prekey'in dogrulugunu kanitlar
// registration_id: Rastgele 32-bit tamsayi — Signal session tanimlayicisi
type Device struct {
	ID                   string    `json:"id"`
	UserID               string    `json:"user_id"`
	DeviceID             string    `json:"device_id"`
	DisplayName          *string   `json:"display_name,omitempty"`
	IdentityKey          string    `json:"identity_key"`
	SigningKey           *string   `json:"signing_key,omitempty"` // Ed25519 public — signed prekey doğrulama
	SignedPrekey         string    `json:"signed_prekey"`
	SignedPrekeyID       int       `json:"signed_prekey_id"`
	SignedPrekeySig      string    `json:"signed_prekey_signature"`
	RegistrationID       int       `json:"registration_id"`
	LastSeenAt           time.Time `json:"last_seen_at"`
	CreatedAt            time.Time `json:"created_at"`
}

// DevicePublicInfo, baska kullanicilarin gorebilecegi cihaz bilgisi.
// Private key veya signature gibi hassas veriler burada YOKTUR.
type DevicePublicInfo struct {
	DeviceID    string    `json:"device_id"`
	DisplayName *string   `json:"display_name,omitempty"`
	IdentityKey string    `json:"identity_key"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
}

// PrekeyBundle, X3DH key agreement icin gereken tam anahtar paketi.
//
// Baska bir kullanici ilk mesajini gondermek istediginde bu bundle'i ceker.
// one_time_prekey tuketildikten sonra sunucudan silinir (tek kullanimlik).
// one_time_prekey nil olabilir — havuz tukenmisse X3DH yine de calisir
// (3-DH yerine 4-DH yapilamaz, guvenlik biraz azalir ama calisir).
type PrekeyBundle struct {
	DeviceID             string  `json:"device_id"`
	RegistrationID       int     `json:"registration_id"`
	IdentityKey          string  `json:"identity_key"`
	SigningKey           *string `json:"signing_key,omitempty"` // Ed25519 public — signed prekey doğrulama
	SignedPrekeyID       int     `json:"signed_prekey_id"`
	SignedPrekey         string  `json:"signed_prekey"`
	SignedPrekeySig      string  `json:"signed_prekey_signature"`
	OneTimePrekeyID      *int    `json:"one_time_prekey_id,omitempty"`
	OneTimePrekey        *string `json:"one_time_prekey,omitempty"`
}

// OneTimePrekey, tek kullanimlik ephemeral prekey.
type OneTimePrekey struct {
	ID        string    `json:"id"`
	DeviceID  string    `json:"device_id"`
	UserID    string    `json:"user_id"`
	PrekeyID  int       `json:"prekey_id"`
	PublicKey string    `json:"public_key"`
	CreatedAt time.Time `json:"created_at"`
}

// OTPKey, prekey yukleme istegindeki tek bir prekey.
type OTPKey struct {
	PrekeyID  int    `json:"prekey_id"`
	PublicKey string `json:"public_key"`
}

// RegisterDeviceRequest, yeni cihaz kaydı istegi.
// Ilk giris veya yeni cihaz kurulumunda gonderilir.
type RegisterDeviceRequest struct {
	DeviceID             string   `json:"device_id"`
	DisplayName          string   `json:"display_name"`
	IdentityKey          string   `json:"identity_key"`
	SigningKey           string   `json:"signing_key"` // Ed25519 public — signed prekey doğrulama
	SignedPrekey         string   `json:"signed_prekey"`
	SignedPrekeyID       int      `json:"signed_prekey_id"`
	SignedPrekeySig      string   `json:"signed_prekey_signature"`
	RegistrationID       int      `json:"registration_id"`
	OneTimePrekeys       []OTPKey `json:"one_time_prekeys"`
}

// Validate, RegisterDeviceRequest'in zorunlu alanlari icerip icermedigini kontrol eder.
func (r *RegisterDeviceRequest) Validate() error {
	r.DeviceID = strings.TrimSpace(r.DeviceID)
	if r.DeviceID == "" {
		return fmt.Errorf("device_id is required")
	}
	r.IdentityKey = strings.TrimSpace(r.IdentityKey)
	if r.IdentityKey == "" {
		return fmt.Errorf("identity_key is required")
	}
	r.SignedPrekey = strings.TrimSpace(r.SignedPrekey)
	if r.SignedPrekey == "" {
		return fmt.Errorf("signed_prekey is required")
	}
	r.SignedPrekeySig = strings.TrimSpace(r.SignedPrekeySig)
	if r.SignedPrekeySig == "" {
		return fmt.Errorf("signed_prekey_signature is required")
	}
	return nil
}

// UploadPrekeysRequest, ek one-time prekey yukleme istegi.
type UploadPrekeysRequest struct {
	OneTimePrekeys []OTPKey `json:"one_time_prekeys"`
}

// Validate, UploadPrekeysRequest'in en az bir prekey icerip icermedigini kontrol eder.
func (r *UploadPrekeysRequest) Validate() error {
	if len(r.OneTimePrekeys) == 0 {
		return fmt.Errorf("at least one prekey is required")
	}
	for _, pk := range r.OneTimePrekeys {
		if strings.TrimSpace(pk.PublicKey) == "" {
			return fmt.Errorf("prekey public_key cannot be empty")
		}
	}
	return nil
}

// UpdateSignedPrekeyRequest, signed prekey rotasyon istegi.
type UpdateSignedPrekeyRequest struct {
	SignedPrekey    string `json:"signed_prekey"`
	SignedPrekeyID  int    `json:"signed_prekey_id"`
	SignedPrekeySig string `json:"signed_prekey_signature"`
}

// Validate, UpdateSignedPrekeyRequest'in zorunlu alanlari kontrol eder.
func (r *UpdateSignedPrekeyRequest) Validate() error {
	if strings.TrimSpace(r.SignedPrekey) == "" {
		return fmt.Errorf("signed_prekey is required")
	}
	if strings.TrimSpace(r.SignedPrekeySig) == "" {
		return fmt.Errorf("signed_prekey_signature is required")
	}
	return nil
}
