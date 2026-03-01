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
	"fmt"
	"net/http"

	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// AuthHandler, auth endpoint'lerini yöneten struct.
// Service interface'i ve rate limiter constructor'dan alınır (DI).
type AuthHandler struct {
	authService  services.AuthService
	loginLimiter *ratelimit.LoginRateLimiter
}

// NewAuthHandler, constructor.
// loginLimiter: Login brute-force koruması. nil ise rate limiting devre dışı kalır.
func NewAuthHandler(authService services.AuthService, loginLimiter *ratelimit.LoginRateLimiter) *AuthHandler {
	return &AuthHandler{
		authService:  authService,
		loginLimiter: loginLimiter,
	}
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
//
// Rate limiting: IP bazlı brute-force koruması.
// - Her IP adresi için belirli bir zaman penceresi içinde izin verilen
//   maksimum login denemesi sayısı sınırlandırılır.
// - Limit aşıldığında 429 Too Many Requests döner.
// - Başarılı login sayacı sıfırlar — meşru kullanıcı bloke olmaz.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	// Rate limit kontrolü — brute-force koruması
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

	// Başarılı login — sayacı sıfırla.
	// Meşru kullanıcı doğru şifreyi girdiğinde sayaç temizlenir,
	// böylece sonraki oturumlarında rate limit'e takılmaz.
	if h.loginLimiter != nil {
		h.loginLimiter.Reset(ip)
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

// ChangeEmail godoc
// PUT /api/users/me/email
// Auth middleware gerektirir — kullanıcı kendi email'ini değiştirir/kaldırır.
//
// Body: { "password": "...", "new_email": "..." }
// Güvenlik: Mevcut şifre doğrulaması zorunlu.
// new_email boş string → email kaldır (NULL).
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

	// Response'ta güncel email bilgisini dön
	var emailResult *string
	if req.NewEmail != "" {
		emailResult = &req.NewEmail
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"message": "email updated",
		"email":   emailResult,
	})
}

// ForgotPassword godoc
// POST /api/auth/forgot-password
// Body: { "email": "..." }
//
// Şifre sıfırlama emaili gönderir.
// Güvenlik: Email DB'de yoksa bile aynı success yanıtı döner (enumeration koruması).
// Cooldown: Aynı email'e 90 saniyede 1 istek. Cooldown aktifse kalan süre response'ta döner.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
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

	// Cooldown aktifse kalan süreyi response'a ekle — frontend geri sayım gösterir
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

// ResetPassword godoc
// POST /api/auth/reset-password
// Body: { "token": "...", "new_password": "..." }
//
// Email'deki token ile şifre sıfırlar. Token doğrulanır, şifre güncellenir, token silinir.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
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

// UserContextKey, context'te kullanıcı bilgisi taşımak için kullanılan key tipi.
//
// Go'da context.Value() any tip kabul eder — string key kullanmak çakışmaya neden olabilir.
// Özel bir tip tanımlayarak namespace collision'ı önleriz.
type contextKey string

const UserContextKey contextKey = "user"

// ServerIDContextKey, context'te aktif sunucu ID'sini taşıyan key.
// ServerMembershipMiddleware tarafından URL path'ten {serverId} okunup eklenir.
// Handler'larda r.Context().Value(ServerIDContextKey).(string) ile erişilir.
const ServerIDContextKey contextKey = "server_id"
