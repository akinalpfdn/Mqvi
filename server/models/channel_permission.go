package models

import "fmt"

// ChannelPermissionOverride — per-channel role permission override.
//
// Effective permission calculation (Discord algorithm):
//   base = OR of all role permissions
//   for each role: allow |= override.allow, deny |= override.deny
//   effective = (base & ~deny) | allow
type ChannelPermissionOverride struct {
	ChannelID string     `json:"channel_id"`
	RoleID    string     `json:"role_id"`
	Allow     Permission `json:"allow"`
	Deny      Permission `json:"deny"`
}

// ChannelOverridablePerms — only in-channel activity permissions can be overridden.
// Server management perms (ManageChannels, ManageRoles, KickMembers, etc.) stay global.
const ChannelOverridablePerms Permission = PermSendMessages | PermReadMessages |
	PermManageMessages | PermConnectVoice | PermSpeak | PermStream | PermViewChannel |
	PermMoveMembers | PermMuteMembers | PermDeafenMembers

type SetOverrideRequest struct {
	Allow Permission `json:"allow"`
	Deny  Permission `json:"deny"`
}

func (r *SetOverrideRequest) Validate() error {
	if r.Allow&r.Deny != 0 {
		return fmt.Errorf("allow and deny cannot have overlapping permission bits")
	}
	if r.Allow & ^ChannelOverridablePerms != 0 {
		return fmt.Errorf("allow contains non-overridable permission bits")
	}
	if r.Deny & ^ChannelOverridablePerms != 0 {
		return fmt.Errorf("deny contains non-overridable permission bits")
	}
	return nil
}
