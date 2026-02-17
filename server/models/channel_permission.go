package models

import "fmt"

// ChannelPermissionOverride, bir kanal için role özel permission override'ı.
//
// Discord'un permission override sistemi:
// - allow: Bu bit'ler role'un varsayılan permission'ına eklenir (izin ver)
// - deny: Bu bit'ler role'un varsayılan permission'ından çıkarılır (engelle)
// - Hiçbiri set edilmemişse (inherit): role'un varsayılan permission'ı geçerli
//
// Effective channel permission hesaplama (Discord algoritması):
//   base = OR of all role permissions
//   for each role user has: allow |= override.allow, deny |= override.deny
//   effective = (base & ~deny) | allow
type ChannelPermissionOverride struct {
	ChannelID string     `json:"channel_id"`
	RoleID    string     `json:"role_id"`
	Allow     Permission `json:"allow"`
	Deny      Permission `json:"deny"`
}

// ChannelOverridablePerms, kanal bazında override edilebilecek permission'lar.
//
// Sunucu yönetim yetkileri (ManageChannels, ManageRoles, KickMembers, BanMembers, Admin,
// ManageInvites) kanal bazında override edilemez — bunlar global kalır.
// Sadece kanal içi aktivite yetkileri override edilebilir.
const ChannelOverridablePerms Permission = PermSendMessages | PermReadMessages |
	PermManageMessages | PermConnectVoice | PermSpeak | PermStream

// SetOverrideRequest, kanal permission override oluşturma/güncelleme isteği.
type SetOverrideRequest struct {
	Allow Permission `json:"allow"`
	Deny  Permission `json:"deny"`
}

// Validate, SetOverrideRequest'in geçerli olup olmadığını kontrol eder.
//
// Kurallar:
// 1. Allow ve deny aynı anda aynı bit'i set edemez (overlap yasak)
// 2. Sadece kanal-level permission'lar override edilebilir
func (r *SetOverrideRequest) Validate() error {
	// Allow ve deny overlap kontrolü
	if r.Allow&r.Deny != 0 {
		return fmt.Errorf("allow and deny cannot have overlapping permission bits")
	}

	// Sadece kanal-level permission'lar override edilebilir
	if r.Allow & ^ChannelOverridablePerms != 0 {
		return fmt.Errorf("allow contains non-overridable permission bits")
	}
	if r.Deny & ^ChannelOverridablePerms != 0 {
		return fmt.Errorf("deny contains non-overridable permission bits")
	}

	return nil
}
