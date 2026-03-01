// Package models — Password reset token ve ilgili request struct'ları.
//
// PasswordResetToken, DB'de saklanan token kaydıdır.
// Token plaintext olarak SAKLANMAZ — SHA256 hash'i saklanır.
// Bu sayede DB sızsa bile tokenlar kullanılamaz.
//
// Request struct'ları HTTP body'den parse edilen verilerdir.
// Validate() method'ları ile geçerlilik kontrolü yapılır.
package models

import (
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"
)

// PasswordResetToken, şifre sıfırlama token'ının DB kaydı.
//
// TokenHash: Token'ın SHA256 hash'i (hex encoded, 64 karakter).
// Plaintext token kullanıcıya email ile gönderilir, DB'de SADECE hash saklanır.
// Doğrulama: kullanıcıdan gelen plaintext token hash'lenir ve TokenHash ile karşılaştırılır.
type PasswordResetToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TokenHash string    `json:"token_hash"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// ForgotPasswordRequest, "şifremi unuttum" isteği.
// Kullanıcı email adresini gönderir, backend reset link'i emailler.
type ForgotPasswordRequest struct {
	Email string `json:"email"`
}

// resetEmailRegex, basit email format kontrolü.
var resetEmailRegex = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// Validate, ForgotPasswordRequest geçerlilik kontrolü.
func (r *ForgotPasswordRequest) Validate() error {
	if r.Email == "" {
		return fmt.Errorf("email is required")
	}
	if !resetEmailRegex.MatchString(r.Email) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

// ResetPasswordRequest, şifre sıfırlama isteği.
// Token: email'deki link'ten alınan plaintext token.
// NewPassword: kullanıcının belirlediği yeni şifre.
type ResetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

// Validate, ResetPasswordRequest geçerlilik kontrolü.
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
