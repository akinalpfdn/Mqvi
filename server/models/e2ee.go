package models

import (
	"fmt"
	"strings"
	"time"
)

// E2EEKeyBackup is a server-stored encrypted key backup.
// Client derives AES-256-GCM key from a recovery password (PBKDF2),
// encrypts all E2EE keys, and uploads the blob. Server cannot read the keys.
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

// CreateKeyBackupRequest is a create/update request for key backup.
type CreateKeyBackupRequest struct {
	Version       int    `json:"version"`
	Algorithm     string `json:"algorithm"`
	EncryptedData string `json:"encrypted_data"`
	Nonce         string `json:"nonce"`
	Salt          string `json:"salt"`
}

// Validate checks required fields.
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

// ChannelGroupSession represents a Sender Key session for a channel.
// session_data is an opaque blob the server cannot read.
// message_index tracks the last known index for key rotation decisions.
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

// CreateGroupSessionRequest is a request to create a new group session.
type CreateGroupSessionRequest struct {
	SessionID   string `json:"session_id"`
	SessionData string `json:"session_data"`
}

// Validate checks required fields.
func (r *CreateGroupSessionRequest) Validate() error {
	if strings.TrimSpace(r.SessionID) == "" {
		return fmt.Errorf("session_id is required")
	}
	if strings.TrimSpace(r.SessionData) == "" {
		return fmt.Errorf("session_data is required")
	}
	return nil
}

// EncryptedMessagePayload carries E2EE fields for encrypted messages.
// Mentions are sent unencrypted so the server can generate notifications —
// a deliberate privacy trade-off (server knows who was mentioned, not the content).
type EncryptedMessagePayload struct {
	EncryptionVersion int               `json:"encryption_version"`
	SenderDeviceID    string            `json:"sender_device_id"`
	Ciphertext        string            `json:"ciphertext,omitempty"`
	Ciphertexts       map[string]string `json:"ciphertexts,omitempty"`
	E2EEMetadata      string            `json:"e2ee_metadata,omitempty"`
	Mentions          []string          `json:"mentions,omitempty"`
}
