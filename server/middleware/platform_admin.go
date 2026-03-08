package middleware

import (
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
)

// PlatformAdminMiddleware requires the user to be a platform admin.
// Runs after AuthMiddleware.
type PlatformAdminMiddleware struct{}

func NewPlatformAdminMiddleware() *PlatformAdminMiddleware {
	return &PlatformAdminMiddleware{}
}

// Require returns 403 if User.IsPlatformAdmin is false.
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
