package models

import "time"

// PinnedMessage — MessageID has a UNIQUE constraint (one pin per message).
type PinnedMessage struct {
	ID        string    `json:"id"`
	MessageID string    `json:"message_id"`
	ChannelID string    `json:"channel_id"`
	PinnedBy  string    `json:"pinned_by"`
	CreatedAt time.Time `json:"created_at"`
}

// PinnedMessageWithDetails includes the full message and who pinned it.
type PinnedMessageWithDetails struct {
	PinnedMessage
	Message  *Message `json:"message"`
	PinnedByUser *User `json:"pinned_by_user,omitempty"`
}
