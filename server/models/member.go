// Package models — MemberWithRoles ve ilgili request struct'ları.
//
// MemberWithRoles nedir?
// Bir kullanıcının tüm bilgilerini + rollerini + hesaplanmış yetkilerini
// tek bir struct'ta birleştiren "view model"dir.
// User struct'ından farklı olarak:
// 1. PasswordHash içermez (API response'a dahil edilmez)
// 2. Roller ve effective permissions eklenmiştir
// 3. API response'larda ve WS event'lerde bu struct kullanılır
package models

import (
	"fmt"
	"math"
	"time"
	"unicode/utf8"
)

// MemberWithRoles, bir kullanıcının üye bilgileri + rolleri + yetkileri.
//
// Bu struct User'ı embed etmiyor (Go embedding) çünkü:
// - User.PasswordHash'i kesinlikle response'a dahil etmemek istiyoruz
// - json:"-" tag'i olsa bile, embed edilen struct'ın field'ları
//   farklı bir context'te sızabilir
// - Computed field'lar (EffectivePermissions) ekleyebiliyoruz
type MemberWithRoles struct {
	ID                   string     `json:"id"`
	Username             string     `json:"username"`
	DisplayName          *string    `json:"display_name"`
	AvatarURL            *string    `json:"avatar_url"`
	Status               UserStatus `json:"status"`
	CustomStatus         *string    `json:"custom_status"`
	CreatedAt            time.Time  `json:"created_at"`
	Roles                []Role     `json:"roles"`
	EffectivePermissions Permission `json:"effective_permissions"`
}

// ToMemberWithRoles, User ve Role listesinden MemberWithRoles oluşturur.
//
// Factory fonksiyon pattern'i:
// Struct oluşturma mantığı tek yerde toplanır.
// Effective permissions hesaplaması (bitwise OR) burada yapılır —
// her yerde tekrar etmek yerine tek noktada merkezi hesaplama.
func ToMemberWithRoles(user *User, roles []Role) MemberWithRoles {
	var effectivePerms Permission
	for _, role := range roles {
		effectivePerms |= role.Permissions
	}

	return MemberWithRoles{
		ID:                   user.ID,
		Username:             user.Username,
		DisplayName:          user.DisplayName,
		AvatarURL:            user.AvatarURL,
		Status:               user.Status,
		CustomStatus:         user.CustomStatus,
		CreatedAt:            user.CreatedAt,
		Roles:                roles,
		EffectivePermissions: effectivePerms,
	}
}

// UpdateProfileRequest, kullanıcının kendi profilini güncellemesi için.
//
// Tüm field'lar pointer — nil ise "değiştirme" anlamına gelir (partial update).
// Bu pattern Go REST API'lerinde standart: nil = omit, non-nil = set.
type UpdateProfileRequest struct {
	DisplayName  *string `json:"display_name"`
	AvatarURL    *string `json:"avatar_url"`
	CustomStatus *string `json:"custom_status"`
	Language     *string `json:"language"`
}

// allowedLanguages, desteklenen dil kodlarını tanımlar.
// Geçersiz bir dil kodu gönderilirse validation hata döner.
var allowedLanguages = map[string]bool{
	"en": true,
	"tr": true,
}

// Validate, UpdateProfileRequest kontrolü.
func (r *UpdateProfileRequest) Validate() error {
	if r.DisplayName != nil && utf8.RuneCountInString(*r.DisplayName) > 32 {
		return fmt.Errorf("display name must be at most 32 characters")
	}
	if r.CustomStatus != nil && utf8.RuneCountInString(*r.CustomStatus) > 128 {
		return fmt.Errorf("custom status must be at most 128 characters")
	}
	if r.Language != nil && !allowedLanguages[*r.Language] {
		return fmt.Errorf("unsupported language: %s", *r.Language)
	}
	return nil
}

// RoleModifyRequest, bir üyenin rollerini değiştirmek için.
//
// RoleIDs hedef rol ID listesidir (tam set).
// Mevcut roller ile diff yapılır: eksik olanlar eklenir, fazla olanlar çıkarılır.
// Bu yaklaşım "declarative" — "ekle/çıkar" komutları yerine "sonuç bu olsun" diyoruz.
type RoleModifyRequest struct {
	RoleIDs []string `json:"role_ids"`
}

// Validate, RoleModifyRequest kontrolü.
func (r *RoleModifyRequest) Validate() error {
	if len(r.RoleIDs) == 0 {
		return fmt.Errorf("at least one role is required")
	}
	return nil
}

// HighestPosition, bir rol listesindeki en yüksek position değerini döner.
//
// Rol hiyerarşisinde position = güç sırası.
// Daha yüksek position = daha güçlü rol.
// Bu fonksiyon hiyerarşi kontrollerinde kullanılır:
// "Bir kullanıcı sadece kendisinden düşük position'daki rolleri yönetebilir."
//
// Owner rolü varsa math.MaxInt32 döner — Owner'ın gücü hiçbir
// position değerine bağlı değildir, her zaman en yüksektir.
// Bu sayede kaç rol oluşturulursa oluşturulsun Owner her zaman üstte kalır.
func HighestPosition(roles []Role) int {
	if HasOwnerRole(roles) {
		return math.MaxInt32
	}
	max := 0
	for _, r := range roles {
		if r.Position > max {
			max = r.Position
		}
	}
	return max
}
