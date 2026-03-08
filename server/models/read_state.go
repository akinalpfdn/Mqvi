package models

import "time"

// ReadState — watermark pattern: stores "read up to this message" rather than
// marking each message individually. Unread count = messages after this point.
type ReadState struct {
	UserID            string    `json:"user_id"`
	ChannelID         string    `json:"channel_id"`
	LastReadMessageID *string   `json:"last_read_message_id"`
	LastReadAt        time.Time `json:"last_read_at"`
}

// UnreadInfo — unread count for a channel, used for sidebar badges.
type UnreadInfo struct {
	ChannelID   string `json:"channel_id"`
	UnreadCount int    `json:"unread_count"`
}
