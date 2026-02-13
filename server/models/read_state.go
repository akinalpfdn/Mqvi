package models

import "time"

// ReadState, bir kullanıcının belirli bir kanaldaki okuma durumunu temsil eder.
//
// Watermark pattern: Her mesajı tek tek "okundu" olarak işaretlemek yerine
// "bu mesaja kadar okudum" bilgisini tutarız. Okunmamış mesaj sayısı =
// bu mesajdan sonraki mesaj sayısı olarak hesaplanır.
type ReadState struct {
	UserID            string    `json:"user_id"`
	ChannelID         string    `json:"channel_id"`
	LastReadMessageID *string   `json:"last_read_message_id"`
	LastReadAt        time.Time `json:"last_read_at"`
}

// UnreadInfo, bir kanalın okunmamış mesaj bilgisini taşır.
// Frontend'de sidebar badge'i için kullanılır.
type UnreadInfo struct {
	ChannelID  string `json:"channel_id"`
	UnreadCount int   `json:"unread_count"`
}
