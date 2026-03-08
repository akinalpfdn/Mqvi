package models

import "time"

// Permission uses bitfields for efficient storage and checking.
// Check: (perms & PermSendMessages) != 0
// Grant: perms | PermSendMessages
// Revoke: perms &^ PermSendMessages
type Permission int64

const (
	PermManageChannels Permission = 1 << iota // 1
	PermManageRoles                            // 2
	PermKickMembers                            // 4
	PermBanMembers                             // 8
	PermManageMessages                         // 16
	PermSendMessages                           // 32
	PermConnectVoice                           // 64
	PermSpeak                                  // 128
	PermStream                                 // 256
	PermAdmin                                  // 512
	PermManageInvites                          // 1024
	PermReadMessages                           // 2048
	PermViewChannel                            // 4096
	PermMoveMembers                            // 8192
	PermMuteMembers                            // 16384
	PermDeafenMembers                          // 32768
)

// PermAll is the sum of all permissions. Update when adding new perms: (1 << N) - 1
const PermAll Permission = (1 << 16) - 1

// Has checks if a permission is set. Admin bypasses all checks.
func (p Permission) Has(perm Permission) bool {
	if p&PermAdmin != 0 {
		return true
	}
	return p&perm != 0
}

// OwnerRoleID is kept for backward compatibility with seeded data.
// New servers identify the owner role via the IsOwner field.
const OwnerRoleID = "owner"

func HasOwnerRole(roles []Role) bool {
	for _, r := range roles {
		if r.IsOwner {
			return true
		}
	}
	return false
}

type Role struct {
	ID          string     `json:"id"`
	ServerID    string     `json:"server_id"`
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Position    int        `json:"position"`
	Permissions Permission `json:"permissions"`
	IsDefault   bool       `json:"is_default"`
	IsOwner     bool       `json:"is_owner"`
	CreatedAt   time.Time  `json:"created_at"`
}
