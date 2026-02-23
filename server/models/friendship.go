// Package models — Friendship domain modeli.
//
// Arkadaşlık sistemi tek tablo üzerinden çalışır:
// - "pending": İstek gönderildi, henüz kabul edilmedi
// - "accepted": Arkadaşlık aktif
// - "blocked": Kullanıcı engellendi
//
// user_id her zaman isteği gönderen / engeli koyan taraftır.
// friend_id hedef kullanıcıdır.
package models

import (
	"fmt"
	"strings"
	"time"
)

// FriendshipStatus, arkadaşlık durumunu temsil eden typed constant.
// Go'da enum yoktur — typed string constant'lar kullanılır.
type FriendshipStatus string

const (
	FriendshipStatusPending  FriendshipStatus = "pending"
	FriendshipStatusAccepted FriendshipStatus = "accepted"
	FriendshipStatusBlocked  FriendshipStatus = "blocked"
)

// Friendship, bir arkadaşlık kaydını temsil eder.
// DB'deki "friendships" tablosunun Go karşılığıdır.
type Friendship struct {
	ID        string           `json:"id"`
	UserID    string           `json:"user_id"`    // İsteği gönderen / engeli koyan
	FriendID  string           `json:"friend_id"`  // Hedef kullanıcı
	Status    FriendshipStatus `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

// FriendshipWithUser, arkadaşlık kaydını diğer kullanıcının bilgisiyle döner.
// Frontend'de arkadaş listesi ve istek listesi gösterirken kullanılır.
//
// "Diğer kullanıcı" = Eğer ben user_id isem → friend bilgisi,
// eğer ben friend_id isem → user bilgisi. Service katmanı bu ayrımı yapar.
type FriendshipWithUser struct {
	ID        string           `json:"id"`
	Status    FriendshipStatus `json:"status"`
	CreatedAt time.Time        `json:"created_at"`
	// Karşı tarafın bilgileri (JOIN ile gelir)
	UserID          string  `json:"user_id"`
	Username        string  `json:"username"`
	DisplayName     *string `json:"display_name"`
	AvatarURL       *string `json:"avatar_url"`
	UserStatus      string  `json:"user_status"`       // online/idle/dnd/offline
	UserCustomStatus *string `json:"user_custom_status"`
}

// SendFriendRequestRequest, arkadaşlık isteği gönderme payload'ı.
// Username ile arama yapılır — ID frontend'de bilinmeyebilir.
type SendFriendRequestRequest struct {
	Username string `json:"username"`
}

// Validate, SendFriendRequestRequest kontrolü.
func (r *SendFriendRequestRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	if r.Username == "" {
		return fmt.Errorf("username is required")
	}
	return nil
}
