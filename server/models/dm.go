package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// DMChannel, iki kullanıcı arasındaki özel mesajlaşma kanalını temsil eder.
//
// user1_id < user2_id sıralaması service katmanında sağlanır.
// Bu sayede aynı iki kullanıcı arasında sadece tek bir kanal oluşabilir
// (UNIQUE constraint user1_id, user2_id çifti üzerinde).
type DMChannel struct {
	ID        string    `json:"id"`
	User1ID   string    `json:"user1_id"`
	User2ID   string    `json:"user2_id"`
	CreatedAt time.Time `json:"created_at"`
}

// DMChannelWithUser, DM kanal bilgisi + karşı taraf kullanıcı bilgisi.
// Frontend'de DM listesi render etmek için kullanılır —
// hangi kullanıcıyla konuştuğunu göstermek için karşı tarafın bilgisi gerekli.
type DMChannelWithUser struct {
	ID        string    `json:"id"`
	OtherUser *User     `json:"other_user"` // Karşı taraf kullanıcı bilgisi
	CreatedAt time.Time `json:"created_at"`
}

// DMMessage, bir DM mesajını temsil eder.
// Server mesajlarıyla benzer yapıda ama ayrı tabloda tutulur.
type DMMessage struct {
	ID          string     `json:"id"`
	DMChannelID string     `json:"dm_channel_id"`
	UserID      string     `json:"user_id"`
	Content     *string    `json:"content"`
	EditedAt    *time.Time `json:"edited_at"`
	CreatedAt   time.Time  `json:"created_at"`
	Author      *User      `json:"author,omitempty"`
}

// DMAttachment, bir DM mesajına eklenmiş dosyayı temsil eder.
type DMAttachment struct {
	ID          string    `json:"id"`
	DMMessageID string    `json:"dm_message_id"`
	Filename    string    `json:"filename"`
	FileURL     string    `json:"file_url"`
	FileSize    *int64    `json:"file_size"`
	MimeType    *string   `json:"mime_type"`
	CreatedAt   time.Time `json:"created_at"`
}

// CreateDMMessageRequest, yeni DM mesajı oluşturma isteği.
type CreateDMMessageRequest struct {
	Content string `json:"content"`
}

// Validate, CreateDMMessageRequest'in geçerli olup olmadığını kontrol eder.
func (r *CreateDMMessageRequest) Validate() error {
	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)
	if contentLen < 1 {
		return fmt.Errorf("message content is required")
	}
	if contentLen > 2000 {
		return fmt.Errorf("message content must be at most 2000 characters")
	}
	return nil
}

// UpdateDMMessageRequest, DM mesajı düzenleme isteği.
type UpdateDMMessageRequest struct {
	Content string `json:"content"`
}

// Validate, UpdateDMMessageRequest'in geçerli olup olmadığını kontrol eder.
func (r *UpdateDMMessageRequest) Validate() error {
	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)
	if contentLen < 1 {
		return fmt.Errorf("message content is required")
	}
	if contentLen > 2000 {
		return fmt.Errorf("message content must be at most 2000 characters")
	}
	return nil
}

// DMMessagePage, DM mesajları için cursor-based pagination response.
type DMMessagePage struct {
	Messages []DMMessage `json:"messages"`
	HasMore  bool        `json:"has_more"`
}
