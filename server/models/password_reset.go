package models

import (
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"
)

// PasswordResetToken — only the SHA256 hash is stored; plaintext is sent via email.
// If DB is compromised, tokens remain unusable.
type PasswordResetToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TokenHash string    `json:"token_hash"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type ForgotPasswordRequest struct {
	Email string `json:"email"`
}

var resetEmailRegex = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func (r *ForgotPasswordRequest) Validate() error {
	if r.Email == "" {
		return fmt.Errorf("email is required")
	}
	if !resetEmailRegex.MatchString(r.Email) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

type ResetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (r *ResetPasswordRequest) Validate() error {
	if r.Token == "" {
		return fmt.Errorf("token is required")
	}
	if r.NewPassword == "" {
		return fmt.Errorf("new password is required")
	}
	if utf8.RuneCountInString(r.NewPassword) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}
	return nil
}
