// Package models — Server domain modeli.
//
// Server, bir sunucuyu temsil eder (Discord'taki "guild" benzeri).
// Çoklu sunucu mimarisi: her kullanıcı birden fazla sunucuya üye olabilir.
package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Server, sunucu verisini temsil eder.
// DB'deki "servers" tablosunun Go karşılığıdır.
type Server struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	IconURL           *string   `json:"icon_url"`
	OwnerID           string    `json:"owner_id"`
	InviteRequired    bool      `json:"invite_required"`
	LiveKitInstanceID *string   `json:"livekit_instance_id,omitempty"` // nil = voice yok
	CreatedAt         time.Time `json:"created_at"`
}

// ServerListItem, kullanıcının sunucu listesi için minimal veri.
// Sidebar'daki server icon listesinde kullanılır — gereksiz detay yok.
type ServerListItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

// CreateServerRequest, yeni sunucu oluşturma isteği.
//
// HostType: "mqvi_hosted" → platform LiveKit'i atanır.
//
//	"self_hosted" → kullanıcı kendi LiveKit bilgilerini verir.
type CreateServerRequest struct {
	Name          string `json:"name"`
	HostType      string `json:"host_type"` // "mqvi_hosted" | "self_hosted"
	LiveKitURL    string `json:"livekit_url,omitempty"`
	LiveKitKey    string `json:"livekit_key,omitempty"`
	LiveKitSecret string `json:"livekit_secret,omitempty"`
}

// Validate, CreateServerRequest kontrolü.
func (r *CreateServerRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 100 {
		return fmt.Errorf("server name must be between 1 and 100 characters")
	}

	if r.HostType != "mqvi_hosted" && r.HostType != "self_hosted" {
		return fmt.Errorf("host_type must be 'mqvi_hosted' or 'self_hosted'")
	}

	if r.HostType == "self_hosted" {
		r.LiveKitURL = strings.TrimSpace(r.LiveKitURL)
		r.LiveKitKey = strings.TrimSpace(r.LiveKitKey)
		r.LiveKitSecret = strings.TrimSpace(r.LiveKitSecret)

		if r.LiveKitURL == "" {
			return fmt.Errorf("livekit_url is required for self-hosted servers")
		}
		if r.LiveKitKey == "" {
			return fmt.Errorf("livekit_key is required for self-hosted servers")
		}
		if r.LiveKitSecret == "" {
			return fmt.Errorf("livekit_secret is required for self-hosted servers")
		}
	}

	return nil
}

// UpdateServerRequest, sunucu güncelleme isteği.
//
// Partial update pattern: nil field'lar değiştirilmez.
type UpdateServerRequest struct {
	Name           *string `json:"name"`
	InviteRequired *bool   `json:"invite_required"`
}

// Validate, UpdateServerRequest kontrolü.
func (r *UpdateServerRequest) Validate() error {
	if r.Name != nil {
		nameLen := utf8.RuneCountInString(*r.Name)
		if nameLen < 1 || nameLen > 100 {
			return fmt.Errorf("server name must be between 1 and 100 characters")
		}
	}
	return nil
}

// JoinServerRequest, davet koduyla sunucuya katılma isteği.
type JoinServerRequest struct {
	InviteCode string `json:"invite_code"`
}

// Validate, JoinServerRequest kontrolü.
func (r *JoinServerRequest) Validate() error {
	r.InviteCode = strings.TrimSpace(r.InviteCode)
	if r.InviteCode == "" {
		return fmt.Errorf("invite_code is required")
	}
	return nil
}
