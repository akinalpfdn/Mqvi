package models

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

func EmailRegex() *regexp.Regexp {
	return emailRegex
}

type UserStatus string

const (
	UserStatusOnline  UserStatus = "online"
	UserStatusIdle    UserStatus = "idle"
	UserStatusDND     UserStatus = "dnd"
	UserStatusOffline UserStatus = "offline"
)

type User struct {
	ID              string     `json:"id"`
	Username        string     `json:"username"`
	DisplayName     *string    `json:"display_name"`
	AvatarURL       *string    `json:"avatar_url"`
	PasswordHash    string     `json:"-"`
	Status          UserStatus `json:"status"`
	PrefStatus      UserStatus `json:"pref_status"`
	CustomStatus    *string    `json:"custom_status"`
	Email           *string    `json:"email"`
	Language        string     `json:"language"`
	IsPlatformAdmin   bool       `json:"is_platform_admin"`
	IsPlatformBanned  bool       `json:"is_platform_banned"`
	PlatformBanReason string     `json:"-"`
	PlatformBannedBy  string     `json:"-"`
	PlatformBannedAt  *time.Time `json:"-"`
	CreatedAt         time.Time  `json:"created_at"`
}

type CreateUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	InviteCode  string `json:"invite_code"`
}

func (r *CreateUserRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	usernameLen := utf8.RuneCountInString(r.Username)
	if usernameLen < 3 || usernameLen > 32 {
		return fmt.Errorf("username must be between 3 and 32 characters")
	}

	for _, ch := range r.Username {
		if !isValidUsernameChar(ch) {
			return fmt.Errorf("username can only contain letters, numbers, and underscores")
		}
	}

	if utf8.RuneCountInString(r.Password) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}

	r.DisplayName = strings.TrimSpace(r.DisplayName)
	if utf8.RuneCountInString(r.DisplayName) > 32 {
		return fmt.Errorf("display name must be at most 32 characters")
	}

	r.Email = strings.TrimSpace(r.Email)
	if r.Email != "" && !emailRegex.MatchString(r.Email) {
		return fmt.Errorf("invalid email format")
	}

	return nil
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (r *LoginRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	if r.Username == "" {
		return fmt.Errorf("username is required")
	}
	if r.Password == "" {
		return fmt.Errorf("password is required")
	}
	return nil
}

type UpdateUserRequest struct {
	DisplayName  *string `json:"display_name"`
	CustomStatus *string `json:"custom_status"`
	Language     *string `json:"language"`
}

// ChangeEmailRequest requires current password for security.
type ChangeEmailRequest struct {
	Password string `json:"password"`
	NewEmail string `json:"new_email"` // empty string = remove email
}

func (r *ChangeEmailRequest) Validate() error {
	if r.Password == "" {
		return fmt.Errorf("password is required")
	}
	r.NewEmail = strings.TrimSpace(r.NewEmail)
	if r.NewEmail != "" && !emailRegex.MatchString(r.NewEmail) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

func isValidUsernameChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') ||
		(ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') ||
		ch == '_'
}
