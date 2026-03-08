package models

import (
	"fmt"
	"strings"
	"time"
)

type FriendshipStatus string

const (
	FriendshipStatusPending  FriendshipStatus = "pending"
	FriendshipStatusAccepted FriendshipStatus = "accepted"
	FriendshipStatusBlocked  FriendshipStatus = "blocked"
)

// Friendship — user_id is always the sender/blocker, friend_id is the target.
type Friendship struct {
	ID        string           `json:"id"`
	UserID    string           `json:"user_id"`
	FriendID  string           `json:"friend_id"`
	Status    FriendshipStatus `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

// FriendshipWithUser includes the other user's profile info.
// The service layer resolves which side is "the other user".
type FriendshipWithUser struct {
	ID        string           `json:"id"`
	Status    FriendshipStatus `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	UserID          string  `json:"user_id"`
	Username        string  `json:"username"`
	DisplayName     *string `json:"display_name"`
	AvatarURL       *string `json:"avatar_url"`
	UserStatus      string  `json:"user_status"`
	UserCustomStatus *string `json:"user_custom_status"`
}

type SendFriendRequestRequest struct {
	Username string `json:"username"`
}

func (r *SendFriendRequestRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	if r.Username == "" {
		return fmt.Errorf("username is required")
	}
	return nil
}
