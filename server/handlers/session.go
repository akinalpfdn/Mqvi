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

// SessionHandler serves the active-devices screen.
type SessionHandler struct {
	sessionService services.SessionService
	revokeLimiter  *ratelimit.LoginRateLimiter // per user; nil disables
}

func NewSessionHandler(sessionService services.SessionService, revokeLimiter *ratelimit.LoginRateLimiter) *SessionHandler {
	return &SessionHandler{sessionService: sessionService, revokeLimiter: revokeLimiter}
}

func requestSession(r *http.Request) (*models.User, string, bool) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		return nil, "", false
	}
	sid, _ := r.Context().Value(ctxkeys.AuthSessionID).(string) // "" for tokens without a sid
	return user, sid, true
}

func (h *SessionHandler) allowRevoke(w http.ResponseWriter, userID string) bool {
	if h.revokeLimiter == nil || h.revokeLimiter.Allow(userID) {
		return true
	}
	retryAfter := h.revokeLimiter.RetryAfterSeconds(userID)
	w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
	pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many requests, please try again later")
	return false
}

// List handles GET /api/auth/sessions
func (h *SessionHandler) List(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := requestSession(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sessions, err := h.sessionService.List(r.Context(), user.ID, sid)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, sessions)
}

// Revoke handles DELETE /api/auth/sessions/{sessionId}
func (h *SessionHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := requestSession(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !h.allowRevoke(w, user.ID) {
		return
	}
	if err := h.sessionService.Revoke(r.Context(), user.ID, sid, r.PathValue("sessionId")); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, nil)
}

// RevokeOthers handles DELETE /api/auth/sessions
func (h *SessionHandler) RevokeOthers(w http.ResponseWriter, r *http.Request) {
	user, sid, ok := requestSession(r)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !h.allowRevoke(w, user.ID) {
		return
	}
	n, err := h.sessionService.RevokeOthers(r.Context(), user.ID, sid)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]int{"revoked": n})
}
