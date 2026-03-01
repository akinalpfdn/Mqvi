// Package middleware — PlatformAdminMiddleware, platform admin yetkisi kontrolü.
//
// AuthMiddleware'den SONRA çalışır — context'te user bilgisi mevcuttur.
// User struct'taki IsPlatformAdmin alanını kontrol eder.
// false ise → 403 Forbidden.
//
// Kullanım:
//
//	authMw.Require(platformAdminMw.Require(http.HandlerFunc(adminHandler.List)))
package middleware

import (
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// PlatformAdminMiddleware, platform admin yetkisi zorunlu kılan middleware.
type PlatformAdminMiddleware struct{}

// NewPlatformAdminMiddleware, constructor.
func NewPlatformAdminMiddleware() *PlatformAdminMiddleware {
	return &PlatformAdminMiddleware{}
}

// Require, platform admin yetkisi zorunlu kılan middleware.
// Context'teki User'ın IsPlatformAdmin alanı false ise → 403 Forbidden.
func (m *PlatformAdminMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		if !user.IsPlatformAdmin {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "platform admin access required")
			return
		}

		next.ServeHTTP(w, r)
	})
}
