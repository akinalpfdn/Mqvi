package models

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var hexColorRegex = regexp.MustCompile(`^#?[0-9a-fA-F]{6}$`)

type CreateRoleRequest struct {
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Permissions Permission `json:"permissions"`
}

func (r *CreateRoleRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	nameLen := utf8.RuneCountInString(r.Name)
	if nameLen < 1 || nameLen > 50 {
		return fmt.Errorf("role name must be between 1 and 50 characters")
	}

	r.Color = strings.TrimSpace(r.Color)
	if !hexColorRegex.MatchString(r.Color) {
		return fmt.Errorf("color must be a valid hex color code (e.g. #FF5733)")
	}
	if !strings.HasPrefix(r.Color, "#") {
		r.Color = "#" + r.Color
	}

	if r.Permissions < 0 || r.Permissions > PermAll {
		return fmt.Errorf("invalid permissions value")
	}

	return nil
}

// UpdateRoleRequest — nil fields are not updated (partial update pattern).
type UpdateRoleRequest struct {
	Name        *string     `json:"name"`
	Color       *string     `json:"color"`
	Permissions *Permission `json:"permissions"`
}

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
