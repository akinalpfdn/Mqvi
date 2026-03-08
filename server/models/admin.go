package models

import (
	"fmt"
	"strings"
)

// AdminServerListItem — server info for platform admin panel. Aggregated in a single query.
type AdminServerListItem struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	IconURL           *string `json:"icon_url"`
	OwnerID           string  `json:"owner_id"`
	OwnerUsername     string  `json:"owner_username"`
	CreatedAt         string  `json:"created_at"`
	IsPlatformManaged bool    `json:"is_platform_managed"`
	LiveKitInstanceID *string `json:"livekit_instance_id"`
	MemberCount       int     `json:"member_count"`
	ChannelCount      int     `json:"channel_count"`
	MessageCount      int     `json:"message_count"`
	StorageMB         float64 `json:"storage_mb"`
	LastActivity      *string `json:"last_activity"`
}

// AdminUserListItem — user info for platform admin panel. Aggregated via correlated subqueries.
type AdminUserListItem struct {
	ID                string  `json:"id"`
	Username          string  `json:"username"`
	DisplayName       *string `json:"display_name"`
	AvatarURL         *string `json:"avatar_url"`
	IsPlatformAdmin   bool    `json:"is_platform_admin"`
	CreatedAt         string  `json:"created_at"`
	Status            string  `json:"status"`
	LastActivity      *string `json:"last_activity"`
	MessageCount      int     `json:"message_count"`
	StorageMB         float64 `json:"storage_mb"`
	OwnedSelfServers  int     `json:"owned_self_servers"`
	OwnedMqviServers  int     `json:"owned_mqvi_servers"`
	MemberServerCount int     `json:"member_server_count"`
	BanCount          int     `json:"ban_count"`
	IsPlatformBanned  bool    `json:"is_platform_banned"`
}

// PlatformBanRequest — DeleteMessages: if true, all user messages (server + DM) are purged.
type PlatformBanRequest struct {
	Reason         string `json:"reason"`
	DeleteMessages bool   `json:"delete_messages"`
}

// HardDeleteUserRequest — reason is optional; if provided, user is notified via email.
type HardDeleteUserRequest struct {
	Reason string `json:"reason"`
}

// AdminDeleteServerRequest — reason is optional; if provided, server owner is notified via email.
type AdminDeleteServerRequest struct {
	Reason string `json:"reason"`
}

type SetPlatformAdminRequest struct {
	IsAdmin bool `json:"is_admin"`
}

type MigrateServerInstanceRequest struct {
	LiveKitInstanceID string `json:"livekit_instance_id"`
}

func (r *MigrateServerInstanceRequest) Validate() error {
	r.LiveKitInstanceID = strings.TrimSpace(r.LiveKitInstanceID)
	if r.LiveKitInstanceID == "" {
		return fmt.Errorf("livekit_instance_id is required")
	}
	return nil
}
