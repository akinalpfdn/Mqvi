package middleware

import (
	"context"
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// PermissionMiddleware, kullanıcının gerekli yetkiye sahip olup olmadığını kontrol eder.
//
// Bu middleware AuthMiddleware'den SONRA çalışır —
// context'te zaten doğrulanmış user bilgisi vardır.
//
// Akış:
// HTTP request → AuthMiddleware (JWT doğrula, user'ı context'e koy)
//              → PermissionMiddleware (user'ın rollerini al, yetkiyi kontrol et)
//              → Handler
type PermissionMiddleware struct {
	roleRepo repository.RoleRepository
}

// NewPermissionMiddleware, constructor.
func NewPermissionMiddleware(roleRepo repository.RoleRepository) *PermissionMiddleware {
	return &PermissionMiddleware{roleRepo: roleRepo}
}

// Require, belirli bir yetkiyi gerektiren middleware döner.
//
// Kullanım:
//
//	permMiddleware.Require(models.PermManageChannels, http.HandlerFunc(channelHandler.Create))
//
// Bu pattern Go'da "middleware factory" olarak bilinir:
// Require bir fonksiyon döner, dönen fonksiyon http.Handler wrap eder.
func (m *PermissionMiddleware) Require(perm models.Permission, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Context'ten user'ı al (AuthMiddleware tarafından eklenir)
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		// Kullanıcının rollerini getir
		roles, err := m.roleRepo.GetByUserID(r.Context(), user.ID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get user roles")
			return
		}

		// Effective permissions: tüm rollerin permission'larının OR'u.
		// Kullanıcının birden fazla rolü olabilir — herhangi birindeki yetki geçerlidir.
		//
		// Bitwise OR nedir?
		// İki sayının bitlerini birleştirir: 32 | 64 = 96
		// Her rol'un permission'ını OR'layarak tüm yetkileri tek sayıda toplarız.
		var effectivePerms models.Permission
		for _, role := range roles {
			effectivePerms |= role.Permissions
		}

		// Yetki kontrolü
		if !effectivePerms.Has(perm) {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "insufficient permissions")
			return
		}

		// Permission'ları context'e ekle (handler'da kullanılabilir — mesaj silme gibi)
		ctx := context.WithValue(r.Context(), handlers.PermissionsContextKey, effectivePerms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
