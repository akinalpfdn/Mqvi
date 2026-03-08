package models

import (
	"fmt"
	"time"
)

type Invite struct {
	Code      string     `json:"code"`
	ServerID  string     `json:"server_id"`
	CreatedBy string     `json:"created_by"`
	MaxUses   int        `json:"max_uses"`   // 0 = unlimited
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at"` // nil = never expires
	CreatedAt time.Time  `json:"created_at"`
}

type InviteWithCreator struct {
	Invite
	CreatorUsername    string  `json:"creator_username"`
	CreatorDisplayName *string `json:"creator_display_name"`
}

// InvitePreview is a public (no auth required) preview for invite cards in chat.
type InvitePreview struct {
	ServerName    string  `json:"server_name"`
	ServerIconURL *string `json:"server_icon_url"`
	MemberCount   int     `json:"member_count"`
}

type CreateInviteRequest struct {
	MaxUses   int `json:"max_uses"`   // 0 = unlimited
	ExpiresIn int `json:"expires_in"` // minutes, 0 = never
}

func (r *CreateInviteRequest) Validate() error {
	if r.MaxUses < 0 {
		return fmt.Errorf("max_uses cannot be negative")
	}
	if r.ExpiresIn < 0 {
		return fmt.Errorf("expires_in cannot be negative")
	}
	return nil
}
