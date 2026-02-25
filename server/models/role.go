package models

import "time"

// Permission, rol yetkilerini bit flag olarak temsil eder.
//
// Bitfield (bit flag) nedir?
// Her yetkiyi bir bit ile temsil ediyoruz. Böylece tek bir integer'da
// birden fazla yetkiyi saklayabiliriz.
//
// Örnek:
//   SEND_MESSAGES = 32 (binary: 00100000)
//   CONNECT_VOICE = 64 (binary: 01000000)
//   İkisine birden sahip kullanıcı: 96 (binary: 01100000)
//
// Kontrol: (permissions & SEND_MESSAGES) != 0 → bu yetki var mı?
// Ekleme: permissions | SEND_MESSAGES → bu yetkiyi ekle
// Çıkarma: permissions &^ SEND_MESSAGES → bu yetkiyi kaldır
type Permission int64

const (
	PermManageChannels Permission = 1 << iota // 1   — iota Go'da auto-increment sabit üretir
	PermManageRoles                            // 2
	PermKickMembers                            // 4
	PermBanMembers                             // 8
	PermManageMessages                         // 16
	PermSendMessages                           // 32
	PermConnectVoice                           // 64
	PermSpeak                                  // 128
	PermStream                                 // 256
	PermAdmin                                  // 512
	PermManageInvites                          // 1024 — davet kodu yönetimi
	PermReadMessages                           // 2048 — kanal mesajlarını okuma (kanal bazlı override için)
	PermViewChannel                            // 4096 — kanal görünürlüğü (sidebar'da görünme, hem text hem voice)
)

// PermAll, tüm yetkilerin toplamıdır (8191).
// Yeni permission eklendikçe bu değer güncellenir: (1 << N) - 1
const PermAll Permission = (1 << 13) - 1

// Has, belirli bir yetkinin var olup olmadığını kontrol eder.
func (p Permission) Has(perm Permission) bool {
	// ADMIN yetkisi her şeye izin verir
	if p&PermAdmin != 0 {
		return true
	}
	return p&perm != 0
}

// OwnerRoleID, sunucu sahibinin rolünün sabit ID'sidir.
// Bu rol seed migration'da oluşturulur ve kimlik bazlı koruma ile korunur:
// - Silinemez, düzenlenemez, sıralanamaz
// - Bu role sahip kullanıcı sunucudan atılamaz/yasaklanamaz
const OwnerRoleID = "owner"

// HasOwnerRole, verilen rol listesinde owner rolünün olup olmadığını kontrol eder.
func HasOwnerRole(roles []Role) bool {
	for _, r := range roles {
		if r.ID == OwnerRoleID {
			return true
		}
	}
	return false
}

// Role, bir kullanıcı rolünü temsil eder.
type Role struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Color       string     `json:"color"`
	Position    int        `json:"position"`
	Permissions Permission `json:"permissions"`
	IsDefault   bool       `json:"is_default"`
	CreatedAt   time.Time  `json:"created_at"`
}
