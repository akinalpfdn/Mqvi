package middleware

import (
	"context"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
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

// Require returns 403 if the user is not a server member or 404 if the server is soft-deleted.
// On success, adds serverID to context via ctxkeys.ServerID.
func (m *ServerMembershipMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := r.Context().Value(ctxkeys.User).(*models.User)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
			return
		}

		serverID := r.PathValue("serverId")
		if serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
			return
		}

		// Reject if server is soft-deleted (members must not see/operate on it).
		if _, err := m.serverRepo.GetActiveByID(r.Context(), serverID); err != nil {
			pkg.ErrorWithMessage(w, http.StatusNotFound, "server not found")
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

		ctx := context.WithValue(r.Context(), ctxkeys.ServerID, serverID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireServerID extracts serverId from the URL into context without any auth check.
// Used for endpoints that handle their own authorization (e.g., restore/permanent-delete
// where the server is soft-deleted and Require would reject it).
func (m *ServerMembershipMiddleware) RequireServerID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverID := r.PathValue("serverId")
		if serverID == "" {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "serverId is required")
			return
		}
		ctx := context.WithValue(r.Context(), ctxkeys.ServerID, serverID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
