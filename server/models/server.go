package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

type Server struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	IconURL           *string   `json:"icon_url"`
	OwnerID           string    `json:"owner_id"`
	InviteRequired    bool      `json:"invite_required"`
	E2EEEnabled       bool      `json:"e2ee_enabled"`
	LiveKitInstanceID *string   `json:"livekit_instance_id,omitempty"` // nil = no voice
	CreatedAt         time.Time `json:"created_at"`
}

// ServerListItem is the minimal data needed for the server icon sidebar.
type ServerListItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

// CreateServerRequest — HostType: "mqvi_hosted" uses platform LiveKit,
// "self_hosted" requires user-provided LiveKit credentials.
type CreateServerRequest struct {
	Name          string `json:"name"`
	HostType      string `json:"host_type"`
	LiveKitURL    string `json:"livekit_url,omitempty"`
	LiveKitKey    string `json:"livekit_key,omitempty"`
	LiveKitSecret string `json:"livekit_secret,omitempty"`
}

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

// UpdateServerRequest — nil fields are not updated (partial update).
type UpdateServerRequest struct {
	Name           *string `json:"name"`
	InviteRequired *bool   `json:"invite_required"`
	E2EEEnabled    *bool   `json:"e2ee_enabled"`
	LiveKitURL    *string `json:"livekit_url,omitempty"`
	LiveKitKey    *string `json:"livekit_key,omitempty"`
	LiveKitSecret *string `json:"livekit_secret,omitempty"`
}

func (r *UpdateServerRequest) HasLiveKitUpdate() bool {
	return r.LiveKitURL != nil || r.LiveKitKey != nil || r.LiveKitSecret != nil
}

func (r *UpdateServerRequest) Validate() error {
	if r.Name != nil {
		nameLen := utf8.RuneCountInString(*r.Name)
		if nameLen < 1 || nameLen > 100 {
			return fmt.Errorf("server name must be between 1 and 100 characters")
		}
	}
	// All 3 LiveKit fields are required together
	if r.HasLiveKitUpdate() {
		if r.LiveKitURL == nil || strings.TrimSpace(*r.LiveKitURL) == "" {
			return fmt.Errorf("livekit_url is required when updating LiveKit settings")
		}
		if r.LiveKitKey == nil || strings.TrimSpace(*r.LiveKitKey) == "" {
			return fmt.Errorf("livekit_key is required when updating LiveKit settings")
		}
		if r.LiveKitSecret == nil || strings.TrimSpace(*r.LiveKitSecret) == "" {
			return fmt.Errorf("livekit_secret is required when updating LiveKit settings")
		}
	}
	return nil
}

type JoinServerRequest struct {
	InviteCode string `json:"invite_code"`
}

func (r *JoinServerRequest) Validate() error {
	r.InviteCode = strings.TrimSpace(r.InviteCode)
	if r.InviteCode == "" {
		return fmt.Errorf("invite_code is required")
	}
	return nil
}

// ReorderServersRequest — per-user server list ordering.
type ReorderServersRequest struct {
	Items []PositionUpdate `json:"items"`
}

func (r *ReorderServersRequest) Validate() error {
	if len(r.Items) == 0 {
		return fmt.Errorf("items cannot be empty")
	}

	seen := make(map[string]bool, len(r.Items))
	for _, item := range r.Items {
		if item.ID == "" {
			return fmt.Errorf("item id cannot be empty")
		}
		if item.Position < 0 {
			return fmt.Errorf("position cannot be negative")
		}
		if seen[item.ID] {
			return fmt.Errorf("duplicate server id: %s", item.ID)
		}
		seen[item.ID] = true
	}

	return nil
}
