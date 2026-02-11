// Package models — Rol CRUD request struct'ları.
//
// CreateRoleRequest ve UpdateRoleRequest, rol oluşturma/güncelleme
// HTTP endpoint'lerinin body parse'ında kullanılır.
// Handler parse eder → Service validate + business logic uygular → Repository DB'ye yazar.
package models

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// hexColorRegex, geçerli bir hex renk kodu kontrolü.
// #RRGGBB formatı: 6 hex karakter (# opsiyonel).
var hexColorRegex = regexp.MustCompile(`^#?[0-9a-fA-F]{6}$`)

// CreateRoleRequest, yeni rol oluşturma isteği.
type CreateRoleRequest struct {
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Permissions Permission `json:"permissions"`
}

// Validate, CreateRoleRequest kontrolü.
func (r *CreateRoleRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 32 {
		return fmt.Errorf("role name must be between 1 and 32 characters")
	}

	r.Color = strings.TrimSpace(r.Color)
	if !hexColorRegex.MatchString(r.Color) {
		return fmt.Errorf("color must be a valid hex color code (e.g. #FF5733)")
	}
	// Normalize: # prefix ekle yoksa
	if !strings.HasPrefix(r.Color, "#") {
		r.Color = "#" + r.Color
	}

	if r.Permissions < 0 || r.Permissions > PermAll {
		return fmt.Errorf("invalid permissions value")
	}

	return nil
}

// UpdateRoleRequest, rol güncelleme isteği.
// Tüm field'lar pointer — nil olanlar güncellenmez (partial update pattern).
type UpdateRoleRequest struct {
	Name        *string     `json:"name"`
	Color       *string     `json:"color"`
	Permissions *Permission `json:"permissions"`
}

// Validate, UpdateRoleRequest kontrolü.
func (r *UpdateRoleRequest) Validate() error {
	if r.Name != nil {
		*r.Name = strings.TrimSpace(*r.Name)
		nameLen := utf8.RuneCountInString(*r.Name)
		if nameLen < 1 || nameLen > 32 {
			return fmt.Errorf("role name must be between 1 and 32 characters")
		}
	}

	if r.Color != nil {
		*r.Color = strings.TrimSpace(*r.Color)
		if !hexColorRegex.MatchString(*r.Color) {
			return fmt.Errorf("color must be a valid hex color code (e.g. #FF5733)")
		}
		if !strings.HasPrefix(*r.Color, "#") {
			*r.Color = "#" + *r.Color
		}
	}

	if r.Permissions != nil {
		if *r.Permissions < 0 || *r.Permissions > PermAll {
			return fmt.Errorf("invalid permissions value")
		}
	}

	return nil
}
