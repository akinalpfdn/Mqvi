package handlers

import (
	"fmt"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// P2PCallChecker reports whether a user is in an ACCEPTED (active) call.
// Minimal interface (ISP) over P2PCallService. Credential issuance is gated on
// an active call — a ringing/outgoing call is not enough, so a caller cannot
// mint relay credentials before the callee accepts. Returns a bool (not the
// internal *P2PCall) so no mutable pointer escapes the service lock.
type P2PCallChecker interface {
	HasActiveCall(userID string) bool
}

// ICEServerHandler serves GET /api/calls/ice-servers.
type ICEServerHandler struct {
	provider    services.ICEServerProvider
	callChecker P2PCallChecker
	limiter     *ratelimit.MessageRateLimiter
}

func NewICEServerHandler(provider services.ICEServerProvider, callChecker P2PCallChecker, limiter *ratelimit.MessageRateLimiter) *ICEServerHandler {
	return &ICEServerHandler{provider: provider, callChecker: callChecker, limiter: limiter}
}

// GetICEServers returns the ICE server list (STUN + TURN with fresh
// credentials) for the authenticated user. Issuance is rate-limited and bound
// to an in-flight P2P call. The frontend MUST fetch this at/after the call
// reaches "active" state, otherwise the caller's request precedes its own call
// registration and is rejected (see Phase 26 constraint).
func (h *ICEServerHandler) GetICEServers(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Gate BEFORE the rate limiter: only requests that will actually mint a
	// credential should consume the issuance budget. Otherwise a buggy client
	// polling without a call could exhaust the user's own quota and 429 their
	// real call into STUN-only.
	//
	// SCALING ASSUMPTION (single backend instance): P2P call state is in-memory
	// in P2PCallService. If the backend is ever scaled horizontally, the instance
	// holding the WS call state may differ from the one serving this HTTP request,
	// so HasActiveCall would return false and a valid call would get 403. Before
	// scaling, move call state to a shared store (e.g. Redis) or pin both to the
	// same instance.
	if !h.callChecker.HasActiveCall(user.ID) {
		pkg.ErrorWithMessage(w, http.StatusForbidden, "no active call")
		return
	}

	if h.limiter != nil && !h.limiter.Allow(user.ID) {
		retryAfter := h.limiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many requests, please wait %s", ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	// Short-lived secret in the body — must not be cached anywhere.
	w.Header().Set("Cache-Control", "no-store")
	pkg.JSON(w, http.StatusOK, models.ICEServersResponse{
		ICEServers: h.provider.ICEServers(user.ID),
	})
}
