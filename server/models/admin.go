package models

import (
	"fmt"
	"strings"
)

// AdminServerListItem — Platform admin panelde gösterilen sunucu bilgisi.
// Tek SQL sorgusu ile tüm istatistikler toplanır.
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

// AdminUserListItem — Platform admin panelde gösterilen kullanıcı bilgisi.
// Tek SQL sorgusu ile tüm istatistikler toplanır (correlated subquery pattern).
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
}

// MigrateServerInstanceRequest — Tek bir sunucunun LiveKit instance'ını değiştirme isteği.
type MigrateServerInstanceRequest struct {
	LiveKitInstanceID string `json:"livekit_instance_id"`
}

// Validate isteği doğrular.
func (r *MigrateServerInstanceRequest) Validate() error {
	r.LiveKitInstanceID = strings.TrimSpace(r.LiveKitInstanceID)
	if r.LiveKitInstanceID == "" {
		return fmt.Errorf("livekit_instance_id is required")
	}
	return nil
}
