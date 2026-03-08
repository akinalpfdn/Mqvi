package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// ChannelType, kanalın türünü temsil eder (text veya voice).
// Go'da enum yerine typed constant kullanılır — UserStatus ile aynı pattern.
type ChannelType string

const (
	ChannelTypeText  ChannelType = "text"
	ChannelTypeVoice ChannelType = "voice"
)

// Channel, bir sunucu kanalını temsil eder (text chat veya voice).
// DB'deki "channels" tablosunun Go karşılığı.
// ServerID, kanalın hangi sunucuya ait olduğunu belirtir.
type Channel struct {
	ID         string      `json:"id"`
	ServerID   string      `json:"server_id"`
	Name       string      `json:"name"`
	Type       ChannelType `json:"type"`
	CategoryID *string     `json:"category_id"` // Nullable — kategorisiz kanal olabilir
	Topic      *string     `json:"topic"`
	Position   int         `json:"position"`
	UserLimit  int         `json:"user_limit"` // 0 = sınırsız (sadece voice kanallar için)
	Bitrate    int         `json:"bitrate"`    // Ses kalitesi (sadece voice kanallar için)
	CreatedAt  time.Time   `json:"created_at"`
}

// Category, kanalları gruplamak için kullanılan kategorileri temsil eder.
// Discord'daki "TEXT CHANNELS", "VOICE CHANNELS" gibi başlıklar.
// ServerID, kategorinin hangi sunucuya ait olduğunu belirtir.
type Category struct {
	ID        string    `json:"id"`
	ServerID  string    `json:"server_id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// CategoryWithChannels, bir kategoriyi ve altındaki kanalları gruplar.
// API response'unda sidebar'da gösterim için kullanılır.
// Frontend bu yapıyı alıp collapsible kategori listeleri oluşturur.
type CategoryWithChannels struct {
	Category Category  `json:"category"`
	Channels []Channel `json:"channels"`
}

// CreateChannelRequest, yeni kanal oluşturma isteği.
type CreateChannelRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`        // "text" veya "voice"
	CategoryID string `json:"category_id"` // Hangi kategoriye ait
	Topic      string `json:"topic"`       // Opsiyonel kanal açıklaması
}

// Validate, CreateChannelRequest'in geçerli olup olmadığını kontrol eder.
func (r *CreateChannelRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 50 {
		return fmt.Errorf("channel name must be between 1 and 50 characters")
	}

	if r.Type != string(ChannelTypeText) && r.Type != string(ChannelTypeVoice) {
		return fmt.Errorf("channel type must be 'text' or 'voice'")
	}

	r.Topic = strings.TrimSpace(r.Topic)
	if utf8.RuneCountInString(r.Topic) > 1024 {
		return fmt.Errorf("channel topic must be at most 1024 characters")
	}

	return nil
}

// UpdateChannelRequest, kanal güncelleme isteği.
// Pointer (*string) kullanılır — nil ise o alan güncellenmez (partial update).
// CategoryID: boş string ("") → kategorisiz yap, non-nil → belirtilen kategoriye taşı.
type UpdateChannelRequest struct {
	Name       *string `json:"name"`
	Topic      *string `json:"topic"`
	CategoryID *string `json:"category_id"`
}

// Validate, UpdateChannelRequest'in geçerli olup olmadığını kontrol eder.
func (r *UpdateChannelRequest) Validate() error {
	if r.Name != nil {
		*r.Name = strings.TrimSpace(*r.Name)
		nameLen := utf8.RuneCountInString(*r.Name)
		if nameLen < 1 || nameLen > 50 {
			return fmt.Errorf("channel name must be between 1 and 50 characters")
		}
	}

	if r.Topic != nil {
		*r.Topic = strings.TrimSpace(*r.Topic)
		if utf8.RuneCountInString(*r.Topic) > 1024 {
			return fmt.Errorf("channel topic must be at most 1024 characters")
		}
	}

	return nil
}

// CreateCategoryRequest, yeni kategori oluşturma isteği.
type CreateCategoryRequest struct {
	Name string `json:"name"`
}

// Validate, CreateCategoryRequest'in geçerli olup olmadığını kontrol eder.
func (r *CreateCategoryRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 50 {
		return fmt.Errorf("category name must be between 1 and 50 characters")
	}
	return nil
}

// UpdateCategoryRequest, kategori güncelleme isteği.
type UpdateCategoryRequest struct {
	Name *string `json:"name"`
}

// Validate, UpdateCategoryRequest'in geçerli olup olmadığını kontrol eder.
func (r *UpdateCategoryRequest) Validate() error {
	if r.Name != nil {
		*r.Name = strings.TrimSpace(*r.Name)
		nameLen := utf8.RuneCountInString(*r.Name)
		if nameLen < 1 || nameLen > 50 {
			return fmt.Errorf("category name must be between 1 and 50 characters")
		}
	}
	return nil
}

// PositionUpdate, kanal sıralama güncellemesi için kullanılan tek bir item.
// Batch reorder API'de kullanılır — her item bir kanalın yeni position değerini taşır.
//
// CategoryID opsiyoneldir (pointer). nil ise kategori değişmez, sadece position güncellenir.
// Cross-category drag-and-drop sırasında kanalın hedef kategorisini belirtmek için kullanılır.
// Roles ve server reorder'da kullanılmaz (nil kalır).
type PositionUpdate struct {
	ID         string  `json:"id"`
	Position   int     `json:"position"`
	CategoryID *string `json:"category_id,omitempty"`
}

// ReorderChannelsRequest, kanal sıralama güncelleme isteği.
// Items listesi, yeni sırada her kanalın id ve position'ını taşır.
type ReorderChannelsRequest struct {
	Items []PositionUpdate `json:"items"`
}

// Validate, ReorderChannelsRequest'in geçerli olup olmadığını kontrol eder.
func (r *ReorderChannelsRequest) Validate() error {
	if len(r.Items) == 0 {
		return fmt.Errorf("items cannot be empty")
	}

	seen := make(map[string]bool, len(r.Items))
	for _, item := range r.Items {
		if item.ID == "" {
			return fmt.Errorf("item id cannot be empty")
		}
		if item.Position < 0 {
			return fmt.Errorf("position cannot be negative")
		}
		if seen[item.ID] {
			return fmt.Errorf("duplicate channel id: %s", item.ID)
		}
		seen[item.ID] = true
	}

	return nil
}

