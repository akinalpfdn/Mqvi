package models

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// Ban — per-server ban. Checked on login and WS connect.
type Ban struct {
	ServerID  string    `json:"server_id"`
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Reason    string    `json:"reason"`
	BannedBy  string    `json:"banned_by"`
	CreatedAt time.Time `json:"created_at"`
}

type BanRequest struct {
	Reason string `json:"reason"`
}

func (r *BanRequest) Validate() error {
	if utf8.RuneCountInString(r.Reason) > 512 {
		return fmt.Errorf("ban reason must be at most 512 characters")
	}
	return nil
}
