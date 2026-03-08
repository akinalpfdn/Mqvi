package models

import "time"

// ServerMember — user-to-server membership (many-to-many).
type ServerMember struct {
	ServerID string    `json:"server_id"`
	UserID   string    `json:"user_id"`
	JoinedAt time.Time `json:"joined_at"`
}
