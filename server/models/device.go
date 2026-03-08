package models

import (
	"fmt"
	"strings"
	"time"
)

// Device represents a user's registered E2EE device.
// Each device has an independent cryptographic identity in Signal Protocol.
// Messages are encrypted separately for each recipient device.
type Device struct {
	ID                   string    `json:"id"`
	UserID               string    `json:"user_id"`
	DeviceID             string    `json:"device_id"`
	DisplayName          *string   `json:"display_name,omitempty"`
	IdentityKey          string    `json:"identity_key"`
	SigningKey           *string   `json:"signing_key,omitempty"` // Ed25519 public — verifies signed prekey
	SignedPrekey         string    `json:"signed_prekey"`
	SignedPrekeyID       int       `json:"signed_prekey_id"`
	SignedPrekeySig      string    `json:"signed_prekey_signature"`
	RegistrationID       int       `json:"registration_id"`
	LastSeenAt           time.Time `json:"last_seen_at"`
	CreatedAt            time.Time `json:"created_at"`
}

// DevicePublicInfo is the public subset of device info visible to other users.
type DevicePublicInfo struct {
	DeviceID    string    `json:"device_id"`
	DisplayName *string   `json:"display_name,omitempty"`
	IdentityKey string    `json:"identity_key"`
	CreatedAt   time.Time `json:"created_at"`
	LastSeenAt  time.Time `json:"last_seen_at"`
}

// PrekeyBundle contains the full key bundle needed for X3DH key agreement.
// one_time_prekey is consumed (deleted) after use; nil if pool is exhausted.
type PrekeyBundle struct {
	DeviceID             string  `json:"device_id"`
	RegistrationID       int     `json:"registration_id"`
	IdentityKey          string  `json:"identity_key"`
	SigningKey           *string `json:"signing_key,omitempty"` // Ed25519 public — verifies signed prekey
	SignedPrekeyID       int     `json:"signed_prekey_id"`
	SignedPrekey         string  `json:"signed_prekey"`
	SignedPrekeySig      string  `json:"signed_prekey_signature"`
	OneTimePrekeyID      *int    `json:"one_time_prekey_id,omitempty"`
	OneTimePrekey        *string `json:"one_time_prekey,omitempty"`
}

// OneTimePrekey is a single-use ephemeral prekey.
type OneTimePrekey struct {
	ID        string    `json:"id"`
	DeviceID  string    `json:"device_id"`
	UserID    string    `json:"user_id"`
	PrekeyID  int       `json:"prekey_id"`
	PublicKey string    `json:"public_key"`
	CreatedAt time.Time `json:"created_at"`
}

// OTPKey is a single prekey entry in an upload request.
type OTPKey struct {
	PrekeyID  int    `json:"prekey_id"`
	PublicKey string `json:"public_key"`
}

// RegisterDeviceRequest is sent on first login or new device setup.
type RegisterDeviceRequest struct {
	DeviceID             string   `json:"device_id"`
	DisplayName          string   `json:"display_name"`
	IdentityKey          string   `json:"identity_key"`
	SigningKey           string   `json:"signing_key"` // Ed25519 public — verifies signed prekey
	SignedPrekey         string   `json:"signed_prekey"`
	SignedPrekeyID       int      `json:"signed_prekey_id"`
	SignedPrekeySig      string   `json:"signed_prekey_signature"`
	RegistrationID       int      `json:"registration_id"`
	OneTimePrekeys       []OTPKey `json:"one_time_prekeys"`
}

// Validate checks required fields.
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

// UploadPrekeysRequest is a request to upload additional one-time prekeys.
type UploadPrekeysRequest struct {
	OneTimePrekeys []OTPKey `json:"one_time_prekeys"`
}

// Validate ensures at least one prekey is provided.
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

// UpdateSignedPrekeyRequest is a signed prekey rotation request.
type UpdateSignedPrekeyRequest struct {
	SignedPrekey    string `json:"signed_prekey"`
	SignedPrekeyID  int    `json:"signed_prekey_id"`
	SignedPrekeySig string `json:"signed_prekey_signature"`
}

// Validate checks required fields.
func (r *UpdateSignedPrekeyRequest) Validate() error {
	if strings.TrimSpace(r.SignedPrekey) == "" {
		return fmt.Errorf("signed_prekey is required")
	}
	if strings.TrimSpace(r.SignedPrekeySig) == "" {
		return fmt.Errorf("signed_prekey_signature is required")
	}
	return nil
}
