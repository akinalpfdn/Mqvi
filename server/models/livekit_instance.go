// Package models — LiveKitInstance domain modeli.
//
// Her sunucu bir LiveKit SFU instance'ına bağlıdır.
// "mqvi hosted" sunucular platform'un LiveKit'ini kullanır,
// "self-hosted" sunucular kullanıcının kendi LiveKit'ini kullanır.
//
// Credential'lar (APIKey, APISecret) DB'de AES-256-GCM ile şifrelenmiş saklanır.
// Bu struct'taki değerler decrypt edilmiş haldir — JSON serialize edilirken
// json:"-" tag'i sayesinde asla client'a gönderilmez.
package models

import (
	"fmt"
	"strings"
	"time"
)

// LiveKitInstance, bir LiveKit SFU sunucu bilgisini temsil eder.
type LiveKitInstance struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	APIKey            string    `json:"-"` // asla client'a gönderme
	APISecret         string    `json:"-"` // asla client'a gönderme
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"` // 0 = sınırsız
	CreatedAt         time.Time `json:"created_at"`
}

// LiveKitInstanceAdminView, admin panelde gösterilen LiveKit instance bilgisi.
// Credential'lar ASLA gönderilmez — sadece URL, kapasite ve sunucu sayısı.
type LiveKitInstanceAdminView struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"`
	CreatedAt         time.Time `json:"created_at"`
}

// CreateLiveKitInstanceRequest, admin panelden yeni LiveKit instance oluşturma isteği.
type CreateLiveKitInstanceRequest struct {
	URL        string `json:"url"`
	APIKey     string `json:"api_key"`
	APISecret  string `json:"api_secret"`
	MaxServers int    `json:"max_servers"` // 0 = sınırsız
}

// Validate, CreateLiveKitInstanceRequest'in geçerli olup olmadığını kontrol eder.
func (r *CreateLiveKitInstanceRequest) Validate() error {
	r.URL = strings.TrimSpace(r.URL)
	if r.URL == "" {
		return fmt.Errorf("url is required")
	}
	r.APIKey = strings.TrimSpace(r.APIKey)
	if r.APIKey == "" {
		return fmt.Errorf("api_key is required")
	}
	r.APISecret = strings.TrimSpace(r.APISecret)
	if r.APISecret == "" {
		return fmt.Errorf("api_secret is required")
	}
	if r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	return nil
}

// UpdateLiveKitInstanceRequest, admin panelden LiveKit instance güncelleme isteği.
// Tüm alanlar optional — sadece gönderilen alanlar güncellenir.
// Credential'lar boş bırakılırsa mevcut değerler korunur.
type UpdateLiveKitInstanceRequest struct {
	URL        *string `json:"url"`
	APIKey     *string `json:"api_key"`
	APISecret  *string `json:"api_secret"`
	MaxServers *int    `json:"max_servers"`
}

// Validate, UpdateLiveKitInstanceRequest'in geçerli olup olmadığını kontrol eder.
func (r *UpdateLiveKitInstanceRequest) Validate() error {
	if r.URL != nil {
		trimmed := strings.TrimSpace(*r.URL)
		r.URL = &trimmed
		if trimmed == "" {
			return fmt.Errorf("url cannot be empty")
		}
	}
	if r.APIKey != nil {
		trimmed := strings.TrimSpace(*r.APIKey)
		r.APIKey = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_key cannot be empty")
		}
	}
	if r.APISecret != nil {
		trimmed := strings.TrimSpace(*r.APISecret)
		r.APISecret = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_secret cannot be empty")
		}
	}
	if r.MaxServers != nil && *r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	return nil
}
