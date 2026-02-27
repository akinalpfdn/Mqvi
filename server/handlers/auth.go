// Package handlers, HTTP request/response işlemlerini yönetir.
//
// Handler'ın görevi çok basit ve "ince" (thin) olmalı:
// 1. Request body'yi parse et (JSON → struct)
// 2. Service katmanını çağır
// 3. Sonucu HTTP response olarak döndür
//
// Handler ASLA iş mantığı (business logic) içermez.
// Handler ASLA doğrudan DB'ye erişmez.
// Tüm akıl service'de, handler sadece köprü.
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// AuthHandler, auth endpoint'lerini yöneten struct.
// Service interface'i constructor'dan alınır (DI).
type AuthHandler struct {
	authService services.AuthService
}

// NewAuthHandler, constructor.
func NewAuthHandler(authService services.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

// Register godoc
// POST /api/auth/register
// İlk kullanıcı otomatik olarak Owner rolü alır.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req models.CreateUserRequest

	// json.NewDecoder: Request body'yi Go struct'ına parse eder.
	// r.Body bir io.Reader'dır — stream olarak okunur, hepsini belleğe almaz.
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

// Login godoc
// POST /api/auth/login
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
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

	pkg.JSON(w, http.StatusOK, tokens)
}

// Refresh godoc
// POST /api/auth/refresh
// Body: { "refresh_token": "..." }
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

// Logout godoc
// POST /api/auth/logout
// Body: { "refresh_token": "..." }
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

// Me godoc
// GET /api/users/me
// Auth middleware gerektirir — context'te user bilgisi olur.
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	// Context'ten user bilgisini al (auth middleware tarafından eklenir)
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pkg.JSON(w, http.StatusOK, user)
}

// ChangePassword godoc
// POST /api/users/me/password
// Auth middleware gerektirir — kullanıcı kendi şifresini değiştirir.
//
// Body: { "current_password": "...", "new_password": "..." }
// Mevcut şifre doğrulandıktan sonra yeni hash oluşturulur.
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

// UserContextKey, context'te kullanıcı bilgisi taşımak için kullanılan key tipi.
//
// Go'da context.Value() any tip kabul eder — string key kullanmak çakışmaya neden olabilir.
// Özel bir tip tanımlayarak namespace collision'ı önleriz.
type contextKey string

const UserContextKey contextKey = "user"
