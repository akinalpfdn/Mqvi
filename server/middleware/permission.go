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
// Bu middleware AuthMiddleware + ServerMembershipMiddleware'den SONRA çalışır —
// context'te zaten doğrulanmış user bilgisi VE serverID mevcuttur.
//
// Multi-server mimaride roller sunucu bazlıdır. Bu yüzden permission kontrolü
// yapılırken context'teki serverID kullanılarak GetByUserIDAndServer çağrılır.
//
// Akış:
// HTTP request → AuthMiddleware (JWT doğrula, user'ı context'e koy)
//              → ServerMembershipMiddleware (serverID'yi context'e koy)
//              → PermissionMiddleware (user'ın o sunucudaki rollerini al, yetkiyi kontrol et)
//              → Handler
type PermissionMiddleware struct {
	roleRepo repository.RoleRepository
}

// NewPermissionMiddleware, constructor.
func NewPermissionMiddleware(roleRepo repository.RoleRepository) *PermissionMiddleware {
	return &PermissionMiddleware{roleRepo: roleRepo}
}

// Load, kullanıcının permission'larını context'e yükler ama herhangi bir
// permission gerektirmez. Handler kendi içinde yetki kontrolü yapar.
//
// Kullanım: mesaj silme gibi "sahibi VEYA yetkili kullanıcı" senaryolarında
// handler'ın hem user ID hem de permission bilgisine ihtiyacı vardır.
// Require kullanırsak sadece yetkili kullanıcılar erişir — normal kullanıcılar
// kendi mesajlarını silemez. Load ile permissions context'e yüklenir,
// handler kararı kendisi verir.
func (m *PermissionMiddleware) Load(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		// ServerID context'ten al — ServerMembershipMiddleware tarafından eklenir.
		serverID, ok := r.Context().Value(handlers.ServerIDContextKey).(string)
		if !ok || serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required for permission check")
			return
		}

		roles, err := m.roleRepo.GetByUserIDAndServer(r.Context(), user.ID, serverID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get user roles")
			return
		}

		var effectivePerms models.Permission
		for _, role := range roles {
			effectivePerms |= role.Permissions
		}

		ctx := context.WithValue(r.Context(), handlers.PermissionsContextKey, effectivePerms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
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

		// ServerID context'ten al — ServerMembershipMiddleware tarafından eklenir.
		serverID, ok := r.Context().Value(handlers.ServerIDContextKey).(string)
		if !ok || serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required for permission check")
			return
		}

		// Kullanıcının o sunucudaki rollerini getir
		roles, err := m.roleRepo.GetByUserIDAndServer(r.Context(), user.ID, serverID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get user roles")
			return
		}

		// Effective permissions: tüm rollerin permission'larının OR'u.
		// Kullanıcının birden fazla rolü olabilir — herhangi birindeki yetki geçerlidir.
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
