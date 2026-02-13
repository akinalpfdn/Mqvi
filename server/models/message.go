package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

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
	Author      *User        `json:"author,omitempty"`       // JOIN ile gelen yazar bilgisi
	Attachments []Attachment `json:"attachments,omitempty"`  // İlişkili dosya ekleri
	Mentions    []string     `json:"mentions"`               // Mesajda bahsedilen kullanıcı ID'leri (@username parse sonucu)
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
type CreateMessageRequest struct {
	Content string `json:"content"`
}

// Validate, CreateMessageRequest'in geçerli olup olmadığını kontrol eder.
// İçerik 1-2000 karakter arası olmalı.
// Not: Sadece dosya içeren mesajlarda content boş olabilir — bu kontrol service katmanında yapılır.
func (r *CreateMessageRequest) Validate() error {
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

// UpdateMessageRequest, mesaj düzenleme isteği.
type UpdateMessageRequest struct {
	Content string `json:"content"`
}

// Validate, UpdateMessageRequest'in geçerli olup olmadığını kontrol eder.
func (r *UpdateMessageRequest) Validate() error {
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
