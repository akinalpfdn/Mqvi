package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxMessageLength applies to both channel and DM messages.
// Must match the frontend constant in client/src/utils/constants.ts.
const MaxMessageLength = 999

// MessageReference holds a preview of the replied-to message.
// If the original message was deleted, Author and Content will be nil.
type MessageReference struct {
	ID      string  `json:"id"`
	Author  *User   `json:"author,omitempty"`
	Content *string `json:"content"`
}

type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	UserID      string       `json:"user_id"`
	Content     *string      `json:"content"`
	EditedAt    *time.Time   `json:"edited_at"`
	CreatedAt   time.Time    `json:"created_at"`
	ReplyToID   *string      `json:"reply_to_id"`
	Author      *User        `json:"author,omitempty"`       // populated via JOIN
	Attachments []Attachment    `json:"attachments,omitempty"`
	Mentions    []string        `json:"mentions"`
	Reactions   []ReactionGroup `json:"reactions"`
	ReferencedMessage *MessageReference `json:"referenced_message,omitempty"`

	// E2EE fields — when encryption_version > 0, Content is nil
	// and the payload is in Ciphertext (opaque base64 blob).
	EncryptionVersion int     `json:"encryption_version"`         // 0=plaintext, 1=E2EE
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

type Attachment struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	Filename  string    `json:"filename"`
	FileURL   string    `json:"file_url"`
	FileSize  *int64    `json:"file_size"`
	MimeType  *string   `json:"mime_type"`
	CreatedAt time.Time `json:"created_at"`
}

// MessagePage is the cursor-based pagination response.
type MessagePage struct {
	Messages []Message `json:"messages"`
	HasMore  bool      `json:"has_more"`
}

// CreateMessageRequest — E2EE: when encryption_version=1, ciphertext is
// required and content may be empty. HasFiles is set by the service layer.
type CreateMessageRequest struct {
	Content   string  `json:"content"`
	ReplyToID *string `json:"reply_to_id,omitempty"`
	HasFiles  bool    `json:"-"`

	EncryptionVersion int     `json:"encryption_version"`
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

func (r *CreateMessageRequest) Validate() error {
	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)

	if r.EncryptionVersion == 1 {
		if r.Ciphertext == nil || *r.Ciphertext == "" {
			return fmt.Errorf("ciphertext is required for encrypted messages")
		}
		if r.SenderDeviceID == nil || *r.SenderDeviceID == "" {
			return fmt.Errorf("sender_device_id is required for encrypted messages")
		}
		return nil
	}

	// Plaintext — file-only messages may have empty content
	if r.HasFiles && contentLen == 0 {
		return nil
	}

	if contentLen < 1 {
		return fmt.Errorf("message content is required")
	}
	if contentLen > MaxMessageLength {
		return fmt.Errorf("message content must be at most %d characters", MaxMessageLength)
	}
	return nil
}

type UpdateMessageRequest struct {
	Content string `json:"content"`

	EncryptionVersion int     `json:"encryption_version"`
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

func (r *UpdateMessageRequest) Validate() error {
	if r.EncryptionVersion == 1 {
		if r.Ciphertext == nil || *r.Ciphertext == "" {
			return fmt.Errorf("ciphertext is required for encrypted messages")
		}
		return nil
	}

	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)
	if contentLen < 1 {
		return fmt.Errorf("message content is required")
	}
	if contentLen > MaxMessageLength {
		return fmt.Errorf("message content must be at most %d characters", MaxMessageLength)
	}
	return nil
}
