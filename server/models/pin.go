package models

import "time"

// PinnedMessage, bir kanaldaki sabitlenmiş mesajı temsil eder.
//
// Pin sistemi nasıl çalışır?
// Bir mesaj pinlendiğinde `pinned_messages` tablosuna kayıt eklenir.
// Unpin edildiğinde bu kayıt silinir. Message tablosu değişmez —
// pin durumu ayrı tabloda tutulur (separation of concerns).
//
// MessageID UNIQUE constraint sayesinde bir mesaj sadece bir kez pinlenebilir.
type PinnedMessage struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	ChannelID string    `json:"channel_id"`
	PinnedBy  string    `json:"pinned_by"`
	CreatedAt time.Time `json:"created_at"`
}

// PinnedMessageWithDetails, pin bilgisiyle birlikte mesaj ve pinleyen kullanıcı
// bilgilerini taşır. API response'unda kullanılır — frontend tek istekle
// pin + mesaj + yazar bilgisini alır.
type PinnedMessageWithDetails struct {
	PinnedMessage
	Message  *Message `json:"message"`            // Pinlenen mesajın kendisi (yazar dahil)
	PinnedByUser *User `json:"pinned_by_user,omitempty"` // Pinleyen kullanıcı bilgisi
}
