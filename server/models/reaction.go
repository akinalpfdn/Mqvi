package models

import "time"

// Reaction — UNIQUE(message_id, user_id, emoji) prevents duplicate reactions.
type Reaction struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	UserID    string    `json:"user_id"`
	Emoji     string    `json:"emoji"`
	CreatedAt time.Time `json:"created_at"`
}

// ReactionGroup aggregates reactions by emoji for API responses.
// Users list lets the frontend highlight "you reacted" state.
type ReactionGroup struct {
	Emoji string   `json:"emoji"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}
