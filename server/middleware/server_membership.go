package middleware

import (
	"context"
	"net/http"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// ServerMembershipMiddleware verifies the user is a member of the target server.
// Extracts {serverId} from the URL path and puts it into context.
// Runs after AuthMiddleware.
type ServerMembershipMiddleware struct {
	serverRepo repository.ServerRepository
}

func NewServerMembershipMiddleware(serverRepo repository.ServerRepository) *ServerMembershipMiddleware {
	return &ServerMembershipMiddleware{serverRepo: serverRepo}
}

// Require returns 403 if the user is not a server member.
// On success, adds serverID to context via handlers.ServerIDContextKey.
func (m *ServerMembershipMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(handlers.UserContextKey).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		serverID := r.PathValue("serverId")
		if serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
			return
		}

		isMember, err := m.serverRepo.IsMember(r.Context(), serverID, user.ID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to check server membership")
			return
		}

		if !isMember {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "you are not a member of this server")
			return
		}

		ctx := context.WithValue(r.Context(), handlers.ServerIDContextKey, serverID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
