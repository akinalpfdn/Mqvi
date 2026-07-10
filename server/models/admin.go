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
	Verified          bool    `json:"verified"`
	Featured          bool    `json:"featured"`
	DiscoveryBlocked  bool    `json:"discovery_blocked"`
	DeletedAt         *string `json:"deleted_at"`
	DeletedByAdmin    bool    `json:"deleted_by_admin"`
}

// AdminListPageParams — common pagination/filter/sort input for admin list endpoints.
// Limit/Offset must be normalized by the caller (handler) before reaching the repo.
// Sort/Dir are validated against per-list whitelists in the repository to block injection.
type AdminListPageParams struct {
	Limit     int
	Offset    int
	Search    string
	Statuses  []string // deletion/account state; OR-combined; empty means all
	Presences []string // users only: presence (online/idle/dnd/offline); OR-combined; empty means all
	Admin     []string // users only: "admin"/"non_admin"; empty or both means all
	Types     []string // servers only: "managed"/"self"; empty or both means all
	Sort      string
	Dir       string // "asc" | "desc"
}

// AdminUserListPage — paged result for /api/admin/users.
type AdminUserListPage struct {
	Items []AdminUserListItem `json:"items"`
	Total int                 `json:"total"`
}

// AdminServerListPage — paged result for /api/admin/servers.
type AdminServerListPage struct {
	Items []AdminServerListItem `json:"items"`
	Total int                   `json:"total"`
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
	QuotaBytes        int64   `json:"quota_bytes"`
	OwnedSelfServers  int     `json:"owned_self_servers"`
	OwnedMqviServers  int     `json:"owned_mqvi_servers"`
	MemberServerCount int     `json:"member_server_count"`
	BanCount          int     `json:"ban_count"`
	IsPlatformBanned  bool    `json:"is_platform_banned"`
	DeletedAt         *string `json:"deleted_at"`
	DeletedByAdmin    bool    `json:"deleted_by_admin"`
	IsHardDeleted     bool    `json:"is_hard_deleted"`
}

// PlatformBanRequest — DeleteMessages: if true, all user messages (server + DM) are purged.
type PlatformBanRequest struct {
	Reason         string `json:"reason"`
	DeleteMessages bool   `json:"delete_messages"`
}

// HardDeleteUserRequest — reason is optional; if provided, user is notified via email.
// HardDelete=false (default) → soft-delete with 30-day TTL. HardDelete=true → tombstone.
type HardDeleteUserRequest struct {
	Reason     string `json:"reason"`
	HardDelete bool   `json:"hard_delete"`
}

// AdminDeleteServerRequest — reason is optional; if provided, server owner is notified via email.
// HardDelete=false (default) → soft delete with 30-day TTL. HardDelete=true → permanent delete.
type AdminDeleteServerRequest struct {
	Reason     string `json:"reason"`
	HardDelete bool   `json:"hard_delete"`
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
