package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

type Server struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	IconURL            *string   `json:"icon_url"`
	OwnerID            string    `json:"owner_id"`
	IsPublic           bool      `json:"is_public"` // listed in the public servers directory (upcoming); joinable without an invite
	E2EEEnabled        bool      `json:"e2ee_enabled"`
	ApprovalRequired   bool      `json:"approval_required"` // joins via invite require approval by a PermApproveMembers holder
	LiveKitInstanceID  *string   `json:"livekit_instance_id,omitempty"` // nil = no voice
	AFKTimeoutMinutes  int       `json:"afk_timeout_minutes"`           // 15/30/45/60, default 60
	// Discovery metadata. Description/BannerURL/Category are owner-editable and optional.
	// Verified/Featured are platform-admin flags.
	Description        *string   `json:"description,omitempty"`
	BannerURL          *string   `json:"banner_url,omitempty"`
	Category           *string   `json:"category,omitempty"`
	Verified           bool      `json:"verified"`
	Featured           bool      `json:"featured"`
	// Soft-delete state. DeletedByAdmin=1 → owner cannot restore (admin moderation).
	DeletedAt          *time.Time `json:"deleted_at,omitempty"`
	DeletedBy          *string    `json:"deleted_by,omitempty"`
	DeletedByAdmin     bool       `json:"deleted_by_admin,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

// ValidServerCategories are the fixed discovery categories. Empty/absent = uncategorized
// (shown only under "All"). Display names are resolved via i18n on the client.
var ValidServerCategories = map[string]bool{
	"gaming":        true,
	"music":         true,
	"entertainment": true,
	"science_tech":  true,
	"education":     true,
	"community":     true,
	"anime_manga":   true,
}

// MaxServerDescriptionLength bounds the discovery description.
const MaxServerDescriptionLength = 300

// ServerListItem is the minimal data needed for the server icon sidebar.
type ServerListItem struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

// SoftDeleteTTLDays is the grace period before a soft-deleted server is hard-deleted by the cleanup worker.
const SoftDeleteTTLDays = 30

// DeletedServerInfo is shown in the owner's "Deleted Servers" UI.
type DeletedServerInfo struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	IconURL            *string   `json:"icon_url"`
	DeletedAt          time.Time `json:"deleted_at"`
	DeletedByAdmin     bool      `json:"deleted_by_admin"`
	PermanentDeleteAt  time.Time `json:"permanent_delete_at"`
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
	Name              *string `json:"name"`
	IsPublic          *bool   `json:"is_public"`
	E2EEEnabled       *bool   `json:"e2ee_enabled"`
	ApprovalRequired  *bool   `json:"approval_required"`
	Description       *string `json:"description,omitempty"`
	Category          *string `json:"category,omitempty"`
	AFKTimeoutMinutes *int    `json:"afk_timeout_minutes,omitempty"`
	LiveKitURL        *string `json:"livekit_url,omitempty"`
	LiveKitKey        *string `json:"livekit_key,omitempty"`
	LiveKitSecret     *string `json:"livekit_secret,omitempty"`
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
	if r.Description != nil {
		*r.Description = strings.TrimSpace(*r.Description)
		if utf8.RuneCountInString(*r.Description) > MaxServerDescriptionLength {
			return fmt.Errorf("description must be at most %d characters", MaxServerDescriptionLength)
		}
	}
	if r.Category != nil && *r.Category != "" && !ValidServerCategories[*r.Category] {
		return fmt.Errorf("invalid server category: %s", *r.Category)
	}
	if r.AFKTimeoutMinutes != nil {
		v := *r.AFKTimeoutMinutes
		if v != 15 && v != 30 && v != 45 && v != 60 {
			return fmt.Errorf("afk_timeout_minutes must be 15, 30, 45, or 60")
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
