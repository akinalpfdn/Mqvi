package models

import (
	"fmt"
	"strings"
	"time"
)

// LiveKitInstance — credentials are stored AES-256-GCM encrypted in DB.
// Values here are decrypted; json:"-" prevents them from ever reaching the client.
type LiveKitInstance struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	APIKey            string    `json:"-"`
	APISecret         string    `json:"-"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"` // 0 = unlimited
	HetznerServerID   string    `json:"hetzner_server_id"`
	CreatedAt         time.Time `json:"created_at"`
}

// LiveKitInstanceAdminView — credentials are NEVER exposed, even to admins.
type LiveKitInstanceAdminView struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"`
	HetznerServerID   string    `json:"hetzner_server_id"`
	CreatedAt         time.Time `json:"created_at"`
}

type CreateLiveKitInstanceRequest struct {
	URL             string `json:"url"`
	APIKey          string `json:"api_key"`
	APISecret       string `json:"api_secret"`
	MaxServers      int    `json:"max_servers"`
	HetznerServerID string `json:"hetzner_server_id"`
}

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

// UpdateLiveKitInstanceRequest — nil fields are not updated.
// Empty credentials keep existing values.
type UpdateLiveKitInstanceRequest struct {
	URL             *string `json:"url"`
	APIKey          *string `json:"api_key"`
	APISecret       *string `json:"api_secret"`
	MaxServers      *int    `json:"max_servers"`
	HetznerServerID *string `json:"hetzner_server_id"`
}

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
