// Package models — Server domain modeli.
//
// Server, tek bir sunucuyu temsil eder.
// mqvi tek sunucu mimarisi kullanır (Discord'daki "guild" benzeri ama tek instance).
// Gelecekte multi-server desteği eklenebilir — model buna hazırdır.
package models

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// Server, sunucu verisini temsil eder.
// DB'deki "server" tablosunun Go karşılığıdır.
type Server struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	IconURL        *string   `json:"icon_url"`
	InviteRequired bool      `json:"invite_required"` // true ise kayıt için davet kodu zorunlu
	CreatedAt      time.Time `json:"created_at"`
}

// UpdateServerRequest, sunucu güncelleme isteği.
//
// Partial update pattern: nil field'lar değiştirilmez.
// Name ve InviteRequired admin tarafından güncellenebilir.
// icon_url avatar handler tarafından güncellenir.
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
