// Package middleware — ServerMembershipMiddleware: sunucu üyelik kontrolü.
//
// URL'den serverId path parameter'ını alır, kullanıcının o sunucuya üye
// olup olmadığını doğrular ve serverID'yi context'e ekler.
//
// Bu middleware AuthMiddleware'den SONRA çalışır — context'te user bilgisi
// zaten mevcuttur.
//
// Akış: HTTP request → AuthMiddleware → ServerMembershipMiddleware → Handler
//
// Eğer kullanıcı sunucu üyesi değilse → 403 Forbidden döner.
// Başarılıysa → context'e serverID ekler, downstream handler'lar
// handlers.ServerIDContextKey ile erişir.
package middleware

import (
	"context"
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// ServerMembershipMiddleware, sunucu üyelik kontrolü middleware'ı.
//
// URL path'ten {serverId} parametresini okur, serverRepo ile üyelik kontrolü yapar.
// Üyelik yoksa 403 döner; varsa serverID'yi context'e ekler.
type ServerMembershipMiddleware struct {
	serverRepo repository.ServerRepository
}

// NewServerMembershipMiddleware, constructor.
func NewServerMembershipMiddleware(serverRepo repository.ServerRepository) *ServerMembershipMiddleware {
	return &ServerMembershipMiddleware{serverRepo: serverRepo}
}

// Require, sunucu üyeliği zorunlu kılan middleware.
//
// Context'ten user bilgisini alır (AuthMiddleware tarafından eklenir),
// URL'den serverId path parameter'ını çeker,
// serverRepo.IsMember ile üyelik kontrolü yapar.
//
// Başarılıysa serverID'yi context'e ekler ve next handler'ı çağırır.
// Başarısızsa (üye değil, sunucu yok, vb.) 403 döner.
func (m *ServerMembershipMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. Context'ten user'ı al
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		// 2. URL path'ten serverId'yi al
		// Go 1.22+ PathValue: route tanımındaki {serverId} parametresini çeker.
		serverID := r.PathValue("serverId")
		if serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
			return
		}

		// 3. Üyelik kontrolü
		isMember, err := m.serverRepo.IsMember(r.Context(), serverID, user.ID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to check server membership")
			return
		}

		if !isMember {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "you are not a member of this server")
			return
		}

		// 4. ServerID'yi context'e ekle
		ctx := context.WithValue(r.Context(), handlers.ServerIDContextKey, serverID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
