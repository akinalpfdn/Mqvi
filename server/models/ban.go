// Package models — Ban (yasaklama) domain modeli.
//
// Ban sistemi nasıl çalışır?
// 1. Admin/Moderator bir kullanıcıyı banlar → bans tablosuna kayıt oluşturulur
// 2. Banlanan kullanıcı anında WS'den disconnect edilir
// 3. Banlı kullanıcı login denemesi yaparsa → reddedilir
// 4. Banlı kullanıcı WS bağlantısı kurmaya çalışırsa → reddedilir
// 5. Unban yapılınca kayıt silinir → kullanıcı tekrar login olabilir
package models

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// Ban, yasaklanmış bir kullanıcıyı temsil eder.
type Ban struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Reason    string    `json:"reason"`
	BannedBy  string    `json:"banned_by"`
	CreatedAt time.Time `json:"created_at"`
}

// BanRequest, ban oluşturma isteği.
type BanRequest struct {
	Reason string `json:"reason"`
}

// Validate, BanRequest kontrolü.
func (r *BanRequest) Validate() error {
	if utf8.RuneCountInString(r.Reason) > 512 {
		return fmt.Errorf("ban reason must be at most 512 characters")
	}
	return nil
}
