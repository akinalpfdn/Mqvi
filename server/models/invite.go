// Package models — Invite domain modeli.
//
// Invite, sunucuya katılmak için kullanılan davet kodunu temsil eder.
// Davet kodları oluşturulabilir, listelenebilir ve silinebilir.
// Her davetin opsiyonel son kullanma tarihi ve maksimum kullanım sayısı olabilir.
package models

import (
	"fmt"
	"time"
)

// Invite, bir davet kodunu temsil eder.
// DB'deki "invites" tablosunun Go karşılığıdır.
// ServerID, davetin hangi sunucuya ait olduğunu belirtir.
type Invite struct {
	Code      string     `json:"code"`
	ServerID  string     `json:"server_id"`
	CreatedBy string     `json:"created_by"`
	MaxUses   int        `json:"max_uses"`   // 0 = sınırsız
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expires_at"` // nil = süresiz
	CreatedAt time.Time  `json:"created_at"`
}

// InviteWithCreator, davet kodunu oluşturan kullanıcının bilgisiyle birlikte döner.
// Frontend'de "Kim oluşturdu?" bilgisini göstermek için kullanılır.
type InviteWithCreator struct {
	Invite
	CreatorUsername    string  `json:"creator_username"`
	CreatorDisplayName *string `json:"creator_display_name"`
}

// InvitePreview, davet kodunun ön izlemesi — mesajdaki invite kartında gösterilir.
// Auth gerektirmez — sunucu adı, ikon ve üye sayısı döner.
type InvitePreview struct {
	ServerName    string  `json:"server_name"`
	ServerIconURL *string `json:"server_icon_url"`
	MemberCount   int     `json:"member_count"`
}

// CreateInviteRequest, yeni bir davet kodu oluşturma isteği.
type CreateInviteRequest struct {
	MaxUses   int `json:"max_uses"`    // 0 = sınırsız
	ExpiresIn int `json:"expires_in"`  // Dakika cinsinden, 0 = süresiz
}

// Validate, CreateInviteRequest kontrolü.
func (r *CreateInviteRequest) Validate() error {
	if r.MaxUses < 0 {
		return fmt.Errorf("max_uses cannot be negative")
	}
	if r.ExpiresIn < 0 {
		return fmt.Errorf("expires_in cannot be negative")
	}
	return nil
}
