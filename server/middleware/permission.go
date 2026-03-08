package middleware

import (
	"context"
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// PermissionMiddleware checks user permissions within a server context.
// Runs after AuthMiddleware + ServerMembershipMiddleware.
type PermissionMiddleware struct {
	roleRepo repository.RoleRepository
}

func NewPermissionMiddleware(roleRepo repository.RoleRepository) *PermissionMiddleware {
	return &PermissionMiddleware{roleRepo: roleRepo}
}

// Load puts effective permissions into context without requiring any specific one.
// Used when the handler needs to make its own authorization decision
// (e.g. "owner OR has ManageMessages").
func (m *PermissionMiddleware) Load(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

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

// Require returns a middleware that enforces a specific permission.
func (m *PermissionMiddleware) Require(perm models.Permission, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

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

		// OR all role permissions — any role granting the perm is sufficient
		var effectivePerms models.Permission
		for _, role := range roles {
			effectivePerms |= role.Permissions
		}

		if !effectivePerms.Has(perm) {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "insufficient permissions")
			return
		}

		ctx := context.WithValue(r.Context(), handlers.PermissionsContextKey, effectivePerms)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
