// Package models, uygulamanın domain modellerini (veri yapıları) tanımlar.
//
// Model nedir?
// Veritabanındaki bir tablonun Go karşılığıdır.
// Aynı zamanda API'den gelen/giden verilerin şeklini de belirler.
//
// Go'da `json:"username"` gibi tag'ler, struct field'larının JSON'a
// nasıl serialize/deserialize edileceğini belirler.
// `db:"username"` tag'leri ise SQL sorgularında kullanılır.
package models

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// emailRegex — basit email format doğrulaması.
// RFC 5322 tam uyum yerine pratik bir regex kullanıyoruz.
var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// EmailRegex, email validation regex'ini döner.
// Service katmanı gibi dış paketlerin email doğrulaması yapabilmesi için export edilir.
func EmailRegex() *regexp.Regexp {
	return emailRegex
}

// UserStatus, kullanıcının çevrimiçi durumunu temsil eder.
// Go'da "type alias" ile string'e özel bir tip veririz —
// bu sayede sadece belirli değerlerin kullanılmasını sağlarız.
type UserStatus string

// İzin verilen UserStatus değerleri — sabitler (const).
// Go'da enum yoktur, bunun yerine typed constant'lar kullanılır.
const (
	UserStatusOnline  UserStatus = "online"
	UserStatusIdle    UserStatus = "idle"
	UserStatusDND     UserStatus = "dnd"
	UserStatusOffline UserStatus = "offline"
)

// User, bir kullanıcıyı temsil eder.
// JSON tag'leri API response'larında, db tag'leri SQL sorgularında kullanılır.
type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	DisplayName  *string    `json:"display_name"`  // *string = nullable — Go'da nil olabilir
	AvatarURL    *string    `json:"avatar_url"`
	PasswordHash string     `json:"-"`             // json:"-" → API response'a DAHİL ETME (güvenlik!)
	Status       UserStatus `json:"status"`
	CustomStatus *string    `json:"custom_status"`
	Email        *string    `json:"email"`    // Opsiyonel — şifremi unuttum için kullanılır
	Language     string     `json:"language"` // Dil tercihi: "en", "tr"
	CreatedAt    time.Time  `json:"created_at"`
}

// CreateUserRequest, kayıt olurken frontend'den gelen veri.
// PasswordHash yerine Password alırız — hash'leme service katmanında yapılır.
// InviteCode opsiyonel — invite_required=true ise zorunlu hale gelir.
type CreateUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`       // Opsiyonel — boş string = email yok
	InviteCode  string `json:"invite_code"`
}

// Validate, CreateUserRequest'in geçerli olup olmadığını kontrol eder.
// Validation kuralları:
//   - Username: 3-32 karakter, alfanumerik + alt çizgi
//   - Password: minimum 8 karakter
//   - DisplayName: opsiyonel, max 32 karakter
//
// Go'da "method receiver" (c *CreateUserRequest) — bu fonksiyon
// CreateUserRequest struct'ına "bağlı"dır, sadece onun üzerinden çağrılabilir:
//
//	req := &CreateUserRequest{...}
//	err := req.Validate()
func (r *CreateUserRequest) Validate() error {
	// Username kontrolü
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

	// Password kontrolü
	if utf8.RuneCountInString(r.Password) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}

	// DisplayName kontrolü (opsiyonel)
	r.DisplayName = strings.TrimSpace(r.DisplayName)
	if utf8.RuneCountInString(r.DisplayName) > 32 {
		return fmt.Errorf("display name must be at most 32 characters")
	}

	// Email kontrolü (opsiyonel — boş string geçerli, ama doluysa format doğrulanır)
	r.Email = strings.TrimSpace(r.Email)
	if r.Email != "" && !emailRegex.MatchString(r.Email) {
		return fmt.Errorf("invalid email format")
	}

	return nil
}

// LoginRequest, giriş yaparken frontend'den gelen veri.
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Validate, LoginRequest'in geçerli olup olmadığını kontrol eder.
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

// UpdateUserRequest, profil güncellemesi için.
type UpdateUserRequest struct {
	DisplayName  *string `json:"display_name"`
	CustomStatus *string `json:"custom_status"`
	Language     *string `json:"language"`
}

// ChangeEmailRequest, email değiştirmek için frontend'den gelen veri.
// Güvenlik gereği mevcut şifre zorunludur.
type ChangeEmailRequest struct {
	Password string `json:"password"`  // Mevcut şifre — doğrulama için
	NewEmail string `json:"new_email"` // Boş string = email kaldır
}

// Validate, ChangeEmailRequest'in geçerli olup olmadığını kontrol eder.
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

// isValidUsernameChar, username'de izin verilen karakterleri kontrol eder.
func isValidUsernameChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') ||
		(ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') ||
		ch == '_'
}
