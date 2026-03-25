package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type AuthHandler struct {
	authService      services.AuthService
	loginLimiter     *ratelimit.LoginRateLimiter
	registerLimiter  *ratelimit.LoginRateLimiter
	forgotPwdLimiter *ratelimit.LoginRateLimiter
	resetPwdLimiter  *ratelimit.LoginRateLimiter
}

// NewAuthHandler creates a new AuthHandler. All limiters may be nil to disable rate limiting.
func NewAuthHandler(
	authService services.AuthService,
	loginLimiter *ratelimit.LoginRateLimiter,
	registerLimiter *ratelimit.LoginRateLimiter,
	forgotPwdLimiter *ratelimit.LoginRateLimiter,
	resetPwdLimiter *ratelimit.LoginRateLimiter,
) *AuthHandler {
	return &AuthHandler{
		authService:      authService,
		loginLimiter:     loginLimiter,
		registerLimiter:  registerLimiter,
		forgotPwdLimiter: forgotPwdLimiter,
		resetPwdLimiter:  resetPwdLimiter,
	}
}

// Register handles POST /api/auth/register
// First registered user automatically becomes Owner.
// IP-based rate limiting prevents registration spam.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.registerLimiter != nil && !h.registerLimiter.Allow(ip) {
		retryAfter := h.registerLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many registration attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.CreateUserRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Register(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, tokens)
}

// Login handles POST /api/auth/login
// IP-based rate limiting protects against brute-force. Successful login resets the counter.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.loginLimiter != nil && !h.loginLimiter.Allow(ip) {
		retryAfter := h.loginLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many login attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.LoginRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	tokens, err := h.authService.Login(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if h.loginLimiter != nil {
		h.loginLimiter.Reset(ip)
	}

	pkg.JSON(w, http.StatusOK, tokens)
}

// Refresh handles POST /api/auth/refresh
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RefreshToken == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	tokens, err := h.authService.RefreshToken(r.Context(), req.RefreshToken)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, tokens)
}

// Logout handles POST /api/auth/logout
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.authService.Logout(r.Context(), req.RefreshToken); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// Me handles GET /api/users/me (requires auth middleware).
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pkg.JSON(w, http.StatusOK, user)
}

// ChangePassword handles POST /api/users/me/password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "current_password and new_password are required")
		return
	}

	if err := h.authService.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "password changed"})
}

// ChangeEmail handles PUT /api/users/me/email
// Requires current password. Empty new_email removes the email (sets NULL).
func (h *AuthHandler) ChangeEmail(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ChangeEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ChangeEmail(r.Context(), user.ID, req.Password, req.NewEmail); err != nil {
		pkg.Error(w, err)
		return
	}

	var emailResult *string
	if req.NewEmail != "" {
		emailResult = &req.NewEmail
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"message": "email updated",
		"email":   emailResult,
	})
}

// ForgotPassword handles POST /api/auth/forgot-password
// Returns same success response whether email exists or not (enumeration protection).
// IP-based rate limiting + per-email 90s cooldown.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.forgotPwdLimiter != nil && !h.forgotPwdLimiter.Allow(ip) {
		retryAfter := h.forgotPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many requests, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ForgotPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	cooldown, err := h.authService.ForgotPassword(r.Context(), req.Email)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if cooldown > 0 {
		pkg.JSON(w, http.StatusOK, map[string]any{
			"message":  "cooldown active",
			"cooldown": cooldown,
		})
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "if the email exists, a reset link has been sent",
	})
}

// ResetPassword handles POST /api/auth/reset-password
// Validates token, updates password, deletes token.
// IP-based rate limiting prevents brute-force token guessing.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	ip := ratelimit.ExtractIP(r)
	if h.resetPwdLimiter != nil && !h.resetPwdLimiter.Allow(ip) {
		retryAfter := h.resetPwdLimiter.RetryAfterSeconds(ip)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many attempts, please try again in %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.ResetPasswordRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.authService.ResetPassword(r.Context(), req.Token, req.NewPassword); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{
		"message": "password has been reset successfully",
	})
}

// contextKey is a typed key for context values to avoid collisions.
type contextKey string

const UserContextKey contextKey = "user"

// ServerIDContextKey carries the active server ID, set by ServerMembershipMiddleware.
const ServerIDContextKey contextKey = "server_id"
