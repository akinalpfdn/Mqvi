package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

type ChannelType string

const (
	ChannelTypeText  ChannelType = "text"
	ChannelTypeVoice ChannelType = "voice"
)

type Channel struct {
	ID         string      `json:"id"`
	ServerID   string      `json:"server_id"`
	Name       string      `json:"name"`
	Type       ChannelType `json:"type"`
	CategoryID *string     `json:"category_id"`
	Topic      *string     `json:"topic"`
	Position   int         `json:"position"`
	UserLimit  int         `json:"user_limit"` // 0 = unlimited (voice only)
	Bitrate    int         `json:"bitrate"`    // voice only
	CreatedAt  time.Time   `json:"created_at"`
}

type Category struct {
	ID        string    `json:"id"`
	ServerID  string    `json:"server_id"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// CategoryWithChannels groups a category with its channels for sidebar rendering.
type CategoryWithChannels struct {
	Category Category  `json:"category"`
	Channels []Channel `json:"channels"`
}

type CreateChannelRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	CategoryID string `json:"category_id"`
	Topic      string `json:"topic"`
}

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

// UpdateChannelRequest uses pointers for partial update — nil means "don't change".
// CategoryID: empty string = remove from category, non-nil = move to target category.
type UpdateChannelRequest struct {
	Name       *string `json:"name"`
	Topic      *string `json:"topic"`
	CategoryID *string `json:"category_id"`
}

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

type CreateCategoryRequest struct {
	Name string `json:"name"`
}

func (r *CreateCategoryRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 50 {
		return fmt.Errorf("category name must be between 1 and 50 characters")
	}
	return nil
}

type UpdateCategoryRequest struct {
	Name *string `json:"name"`
}

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

// PositionUpdate is used for batch reorder APIs (channels, roles, servers).
// CategoryID is only used for cross-category channel moves.
type PositionUpdate struct {
	ID         string  `json:"id"`
	Position   int     `json:"position"`
	CategoryID *string `json:"category_id,omitempty"`
}

type ReorderChannelsRequest struct {
	Items []PositionUpdate `json:"items"`
}

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
