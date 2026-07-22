package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// DMChannel — user1_id < user2_id ordering is enforced by the service layer
// to guarantee a single channel per user pair via UNIQUE constraint.
type DMChannel struct {
	ID            string     `json:"id"`
	User1ID       string     `json:"user1_id"`
	User2ID       string     `json:"user2_id"`
	E2EEEnabled   bool       `json:"e2ee_enabled"`
	Status        string     `json:"status"`       // "accepted" or "pending"
	InitiatedBy   *string    `json:"initiated_by"` // user ID who sent the request (only for pending)
	CreatedAt     time.Time  `json:"created_at"`
	LastMessageAt *time.Time `json:"last_message_at"`
}

const (
	DMStatusAccepted = "accepted"
	DMStatusPending  = "pending"
)

// DMChannelWithUser includes the other participant's info for sidebar rendering.
type DMChannelWithUser struct {
	ID            string     `json:"id"`
	OtherUser     *User      `json:"other_user"`
	E2EEEnabled   bool       `json:"e2ee_enabled"`
	Status        string     `json:"status"`
	InitiatedBy   *string    `json:"initiated_by"`
	CreatedAt     time.Time  `json:"created_at"`
	LastMessageAt *time.Time `json:"last_message_at"`
	IsPinned      bool       `json:"is_pinned"`
	IsMuted       bool       `json:"is_muted"`
	UnreadCount   int        `json:"unread_count"`
}

// DM message types.
const (
	MessageTypeText = "text"
	MessageTypeCall = "call"
)

// Call-log outcomes (CallMeta.Outcome).
const (
	CallOutcomeCompleted = "completed"
	CallOutcomeMissed    = "missed"
	CallOutcomeDeclined  = "declined"
)

// CallMeta is the JSON payload of a message_type="call" DM log entry.
type CallMeta struct {
	CallerID    string `json:"caller_id"`
	CallType    string `json:"call_type"` // "voice" | "video"
	Outcome     string `json:"outcome"`   // completed | missed | declined
	DurationSec int    `json:"duration_sec"`
}

type DMMessage struct {
	ID          string     `json:"id"`
	DMChannelID string     `json:"dm_channel_id"`
	UserID      string     `json:"user_id"`
	Content     *string    `json:"content"`
	EditedAt    *time.Time `json:"edited_at"`
	CreatedAt   time.Time  `json:"created_at"`
	ReplyToID   *string    `json:"reply_to_id"`
	IsPinned    bool       `json:"is_pinned"`

	// message_type distinguishes system messages from normal chat. "text" (default)
	// is a normal/E2EE message; "call" is a plaintext P2P call-log entry.
	MessageType string    `json:"message_type"`
	CallMeta    *CallMeta `json:"call_meta,omitempty"`

	// E2EE — same pattern as Message: Content is nil, payload in Ciphertext
	EncryptionVersion int     `json:"encryption_version"`         // 0=plaintext, 1=E2EE
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`

	// Populated via JOINs
	Author            *User             `json:"author,omitempty"`
	Attachments       []DMAttachment    `json:"attachments"`
	Reactions         []ReactionGroup   `json:"reactions"`
	ReferencedMessage *MessageReference `json:"referenced_message,omitempty"`
}

type DMAttachment struct {
	ID          string    `json:"id"`
	DMMessageID string    `json:"dm_message_id"`
	Filename    string    `json:"filename"`
	FileURL     string    `json:"file_url"`
	FileSize    *int64    `json:"file_size"`
	MimeType    *string   `json:"mime_type"`
	CreatedAt   time.Time `json:"created_at"`
	// Companion preview. Nil for attachments uploaded before thumbnails existed, and for types
	// that have no preview — every consumer must treat its absence as normal.
	ThumbURL    *string   `json:"thumb_url,omitempty"`
	ThumbWidth  *int      `json:"thumb_width,omitempty"`
	ThumbHeight *int      `json:"thumb_height,omitempty"`
	// Charged to the uploader's quota like the original, so the delete path knows what to release.
	ThumbSize *int64 `json:"thumb_size,omitempty"`
}

// CreateDMMessageRequest — E2EE: when encryption_version=1, ciphertext is
// required and content may be empty. HasFiles is set by the service layer.
type CreateDMMessageRequest struct {
	Content   string  `json:"content"`
	ReplyToID *string `json:"reply_to_id,omitempty"`
	HasFiles  bool    `json:"-"`

	EncryptionVersion int     `json:"encryption_version"`
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

func (r *CreateDMMessageRequest) Validate() error {
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

type UpdateDMMessageRequest struct {
	Content string `json:"content"`

	EncryptionVersion int     `json:"encryption_version"`
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

func (r *UpdateDMMessageRequest) Validate() error {
	if r.EncryptionVersion == 1 {
		if r.Ciphertext == nil || *r.Ciphertext == "" {
			return fmt.Errorf("ciphertext is required for encrypted messages")
		}
		// Same rule as the channel edit: the id the recipient decrypts by must not be nulled out.
		if r.SenderDeviceID == nil || *r.SenderDeviceID == "" {
			return fmt.Errorf("sender_device_id is required for encrypted messages")
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

// DMReaction — UNIQUE(dm_message_id, user_id, emoji) prevents duplicate reactions.
type DMReaction struct {
	ID          string    `json:"id"`
	DMMessageID string    `json:"dm_message_id"`
	UserID      string    `json:"user_id"`
	Emoji       string    `json:"emoji"`
	CreatedAt   time.Time `json:"created_at"`
}

type ToggleDMReactionRequest struct {
	Emoji string `json:"emoji"`
}

func (r *ToggleDMReactionRequest) Validate() error {
	r.Emoji = strings.TrimSpace(r.Emoji)
	if r.Emoji == "" {
		return fmt.Errorf("emoji is required")
	}
	return nil
}

type DMMessagePage struct {
	Messages []DMMessage `json:"messages"`
	HasMore  bool        `json:"has_more"`
}

type DMSearchResult struct {
	Messages   []DMMessage `json:"messages"`
	TotalCount int         `json:"total_count"`
}
