package models

import "time"

// Reaction, bir kullanıcının bir mesaja verdiği tek bir emoji tepkisini temsil eder.
// DB'deki "reactions" tablosunun Go karşılığı.
//
// UNIQUE(message_id, user_id, emoji) constraint'i sayesinde
// bir kullanıcı aynı mesaja aynı emojiyi sadece bir kez ekleyebilir.
type Reaction struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	UserID    string    `json:"user_id"`
	Emoji     string    `json:"emoji"`
	CreatedAt time.Time `json:"created_at"`
}

// ReactionGroup, bir mesajdaki aynı emojinin toplu görünümü.
// API response'unda kullanılır — frontend her emoji için
// count ve hangi kullanıcıların tepki verdiğini bilmek ister.
//
// Örnek: 👍 3 [user1, user2, user3]
// Bu sayede frontend:
// 1. Emoji + count gösterir
// 2. Mevcut kullanıcı users listesindeyse .active class ekler
type ReactionGroup struct {
	Emoji string   `json:"emoji"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}
