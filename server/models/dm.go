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
	ID            string     `json:"id"`
	User1ID       string     `json:"user1_id"`
	User2ID       string     `json:"user2_id"`
	CreatedAt     time.Time  `json:"created_at"`
	LastMessageAt *time.Time `json:"last_message_at"` // Nullable — henüz mesaj yoksa nil
}

// DMChannelWithUser, DM kanal bilgisi + karşı taraf kullanıcı bilgisi.
// Frontend'de DM listesi render etmek için kullanılır —
// hangi kullanıcıyla konuştuğunu göstermek için karşı tarafın bilgisi gerekli.
type DMChannelWithUser struct {
	ID            string     `json:"id"`
	OtherUser     *User      `json:"other_user"`      // Karşı taraf kullanıcı bilgisi
	CreatedAt     time.Time  `json:"created_at"`
	LastMessageAt *time.Time `json:"last_message_at"` // Son mesaj aktivitesi — sıralama için
}

// DMMessage, bir DM mesajını temsil eder.
// Server mesajlarıyla benzer yapıda ama ayrı tabloda tutulur.
//
// Channel Message struct'ı ile paralel alanlar:
// - ReplyToID + ReferencedMessage → yanıt desteği
// - Attachments → dosya ekleri
// - Reactions → emoji tepkileri (ReactionGroup ile aynı format)
// - IsPinned → sabitleme
type DMMessage struct {
	ID          string     `json:"id"`
	DMChannelID string     `json:"dm_channel_id"`
	UserID      string     `json:"user_id"`
	Content     *string    `json:"content"`               // Nullable — sadece dosya içeren mesajlarda nil olabilir
	EditedAt    *time.Time `json:"edited_at"`
	CreatedAt   time.Time  `json:"created_at"`
	ReplyToID   *string    `json:"reply_to_id"`            // Nullable — yanıt yapılan DM mesajının ID'si
	IsPinned    bool       `json:"is_pinned"`              // Sabitlenmiş mesaj mı

	// JOIN/aggregate ile doldurulan alanlar
	Author            *User             `json:"author,omitempty"`
	Attachments       []DMAttachment    `json:"attachments"`
	Reactions         []ReactionGroup   `json:"reactions"`
	ReferencedMessage *MessageReference `json:"referenced_message,omitempty"` // Yanıt ön izlemesi
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
//
// ReplyToID opsiyonel — yanıt mesajı gönderilecekse doldurulur.
// HasFiles service katmanında set edilir — multipart form-data'dan dosya
// varsa true olur, bu durumda Content boş olabilir (sadece dosya mesajı).
type CreateDMMessageRequest struct {
	Content   string  `json:"content"`
	ReplyToID *string `json:"reply_to_id,omitempty"` // Opsiyonel — yanıt yapılacak mesajın ID'si
	HasFiles  bool    `json:"-"`                     // Service katmanı tarafından set edilir, JSON'a dahil değil
}

// Validate, CreateDMMessageRequest'in geçerli olup olmadığını kontrol eder.
// Dosya ekli mesajlarda content boş olabilir (channel CreateMessageRequest ile aynı pattern).
func (r *CreateDMMessageRequest) Validate() error {
	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)

	// Dosya varsa ve content boşsa → geçerli (sadece dosya mesajı)
	if r.HasFiles && contentLen == 0 {
		return nil
	}

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

// DMReaction, bir kullanıcının bir DM mesajına verdiği tek bir emoji tepkisi.
// Channel Reaction struct'ı ile aynı yapı — ayrı tablo (dm_reactions).
//
// UNIQUE(dm_message_id, user_id, emoji) constraint'i sayesinde
// bir kullanıcı aynı DM mesajına aynı emojiyi sadece bir kez ekleyebilir.
type DMReaction struct {
	ID          string    `json:"id"`
	DMMessageID string    `json:"dm_message_id"`
	UserID      string    `json:"user_id"`
	Emoji       string    `json:"emoji"`
	CreatedAt   time.Time `json:"created_at"`
}

// ToggleDMReactionRequest, DM mesajına emoji tepkisi ekleme/kaldırma isteği.
// Channel ToggleReactionRequest ile aynı pattern — body'den emoji alınır.
type ToggleDMReactionRequest struct {
	Emoji string `json:"emoji"`
}

// Validate, ToggleDMReactionRequest'in geçerli olup olmadığını kontrol eder.
func (r *ToggleDMReactionRequest) Validate() error {
	r.Emoji = strings.TrimSpace(r.Emoji)
	if r.Emoji == "" {
		return fmt.Errorf("emoji is required")
	}
	return nil
}

// DMMessagePage, DM mesajları için cursor-based pagination response.
type DMMessagePage struct {
	Messages []DMMessage `json:"messages"`
	HasMore  bool        `json:"has_more"`
}

// DMSearchResult, DM arama sonucunu temsil eder.
// Channel SearchResult ile aynı pattern — mesajlar + toplam sonuç sayısı (pagination için).
type DMSearchResult struct {
	Messages   []DMMessage `json:"messages"`
	TotalCount int         `json:"total_count"`
}
