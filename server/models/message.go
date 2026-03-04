package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxMessageLength, bir mesajın maksimum karakter sayısı.
// Hem channel hem DM mesajlarında geçerlidir.
// Frontend'de de aynı limit uygulanır (client/src/utils/constants.ts).
const MaxMessageLength = 999

// MessageReference, yanıt yapılan mesajın ön izleme bilgisi.
//
// Tam Message objesi yerine sadece preview için gereken alanlar taşınır:
// - ID: Scroll-to-message için gerekli
// - Author: Yazar adı + avatar göstermek için
// - Content: Truncated içerik (kırpma frontend'de yapılır)
//
// Eğer yanıt yapılan mesaj silinmişse Author ve Content nil olur —
// frontend bu durumda "Orijinal mesaj silindi" gösterir.
type MessageReference struct {
	ID      string  `json:"id"`
	Author  *User   `json:"author,omitempty"`
	Content *string `json:"content"`
}

// Message, bir chat mesajını temsil eder.
// DB'deki "messages" tablosunun Go karşılığı.
//
// Author ve Attachments alanları JOIN sorguları ile doldurulur —
// veritabanında ayrı tablolardadır ama API response'unda birlikte döner.
// Bu sayede frontend tek bir istekle mesaj + yazar + dosya bilgilerini alır.
type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	UserID      string       `json:"user_id"`
	Content     *string      `json:"content"`               // Nullable — sadece dosya içeren mesajlarda nil olabilir
	EditedAt    *time.Time   `json:"edited_at"`              // Düzenlendiyse zaman damgası
	CreatedAt   time.Time    `json:"created_at"`
	ReplyToID   *string      `json:"reply_to_id"`            // Nullable — yanıt yapılan mesajın ID'si
	Author      *User        `json:"author,omitempty"`       // JOIN ile gelen yazar bilgisi
	Attachments []Attachment    `json:"attachments,omitempty"`  // İlişkili dosya ekleri
	Mentions    []string        `json:"mentions"`               // Mesajda bahsedilen kullanıcı ID'leri (@username parse sonucu)
	Reactions   []ReactionGroup `json:"reactions"`              // Emoji tepkileri (batch load ile doldurulur)
	ReferencedMessage *MessageReference `json:"referenced_message,omitempty"` // LEFT JOIN ile gelen yanıt ön izlemesi

	// E2EE alanları — encryption_version > 0 ise mesaj şifrelidir.
	// Bu durumda Content nil olur, içerik Ciphertext alanında taşınır.
	// Sunucu Ciphertext'i OKUYAMAZ — opak base64 blob olarak saklar/iletir.
	EncryptionVersion int     `json:"encryption_version"`            // 0=plaintext, 1=E2EE
	Ciphertext        *string `json:"ciphertext,omitempty"`          // Base64 şifreli içerik
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`    // Gönderen cihazın ID'si
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`       // JSON: session_id, distribution_id vb.
}

// Attachment, bir mesaja eklenmiş dosyayı temsil eder.
// DB'deki "attachments" tablosunun Go karşılığı.
type Attachment struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	Filename  string    `json:"filename"`
	FileURL   string    `json:"file_url"`
	FileSize  *int64    `json:"file_size"` // Nullable — byte cinsinden
	MimeType  *string   `json:"mime_type"` // Nullable — "image/png", "application/pdf" vb.
	CreatedAt time.Time `json:"created_at"`
}

// MessagePage, cursor-based pagination (sayfalama) sonucu.
//
// Cursor-based pagination nedir?
// Offset-based ("LIMIT 50 OFFSET 100") yerine "bu ID'den önceki 50 mesajı getir" kullanır.
// Avantajı: Yeni mesaj eklendiğinde sayfa kayması olmaz.
// Discord ve tüm modern chat uygulamaları bu yöntemi kullanır.
type MessagePage struct {
	Messages []Message `json:"messages"`
	HasMore  bool      `json:"has_more"` // Daha eski mesajlar var mı?
}

// CreateMessageRequest, yeni mesaj gönderme isteği.
//
// ReplyToID opsiyonel — yanıt mesajı gönderilecekse doldurulur.
// HasFiles service katmanında set edilir — multipart form-data'dan dosya
// varsa true olur, bu durumda Content boş olabilir (sadece dosya mesajı).
//
// E2EE alanları:
// EncryptionVersion = 1 ise mesaj şifrelidir → Ciphertext zorunlu, Content boş olabilir.
// EncryptionVersion = 0 veya nil ise eski plaintext akışı çalışır.
type CreateMessageRequest struct {
	Content   string  `json:"content"`
	ReplyToID *string `json:"reply_to_id,omitempty"` // Opsiyonel — yanıt yapılacak mesajın ID'si
	HasFiles  bool    `json:"-"`                     // Service katmanı tarafından set edilir, JSON'a dahil değil

	// E2EE alanları — frontend şifreli mesaj gönderirken set eder.
	// Sunucu bu alanları olduğu gibi saklar, içerikle ilgilenmez.
	EncryptionVersion int     `json:"encryption_version"` // 0=plaintext (default), 1=E2EE
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

// Validate, CreateMessageRequest'in geçerli olup olmadığını kontrol eder.
//
// Üç durum geçerlidir:
// 1. Plaintext (encryption_version=0): content zorunlu (dosya varsa boş olabilir)
// 2. E2EE (encryption_version=1): ciphertext zorunlu, content boş olabilir
// 3. Dosya ekli: content boş olabilir (hem plaintext hem E2EE)
func (r *CreateMessageRequest) Validate() error {
	r.Content = strings.TrimSpace(r.Content)
	contentLen := utf8.RuneCountInString(r.Content)

	// E2EE mesaj — Ciphertext zorunlu, Content boş olabilir
	if r.EncryptionVersion == 1 {
		if r.Ciphertext == nil || *r.Ciphertext == "" {
			return fmt.Errorf("ciphertext is required for encrypted messages")
		}
		if r.SenderDeviceID == nil || *r.SenderDeviceID == "" {
			return fmt.Errorf("sender_device_id is required for encrypted messages")
		}
		return nil
	}

	// Plaintext — dosya varsa ve content boşsa → geçerli (sadece dosya mesajı)
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

// UpdateMessageRequest, mesaj düzenleme isteği.
//
// E2EE mesajlarda: Content yerine Ciphertext güncellenir.
// encryption_version alanı mesajın mevcut durumundan alınır (değiştirilemez).
type UpdateMessageRequest struct {
	Content string `json:"content"`

	// E2EE alanları — şifreli mesaj düzenlenirken set edilir.
	EncryptionVersion int     `json:"encryption_version"`
	Ciphertext        *string `json:"ciphertext,omitempty"`
	SenderDeviceID    *string `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string `json:"e2ee_metadata,omitempty"`
}

// Validate, UpdateMessageRequest'in geçerli olup olmadığını kontrol eder.
//
// E2EE mesajlarda ciphertext zorunlu, plaintext mesajlarda content zorunlu.
func (r *UpdateMessageRequest) Validate() error {
	// E2EE edit
	if r.EncryptionVersion == 1 {
		if r.Ciphertext == nil || *r.Ciphertext == "" {
			return fmt.Errorf("ciphertext is required for encrypted messages")
		}
		return nil
	}

	// Plaintext edit
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
