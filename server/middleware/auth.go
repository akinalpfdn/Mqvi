// Package middleware, HTTP request pipeline'ına eklenen ara katmanları barındırır.
//
// Middleware Pattern nedir?
// Her HTTP request, handler'a ulaşmadan önce bir veya daha fazla middleware'dan geçer.
// Middleware'lar zincir şeklinde çalışır: Auth → Permission → RateLimit → Handler
//
// Go'da middleware bir fonksiyondur:
//   func(next http.Handler) http.Handler
//
// "next" parametresi zincirdeki bir sonraki handler'dır.
// Middleware kendi işini yapar (ör: token doğrula), sonra next'i çağırır.
// Eğer hata varsa next'i çağırmaz → request burada durur.
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

// AuthMiddleware, JWT token doğrulama middleware'ı.
type AuthMiddleware struct {
	authService services.AuthService
	userRepo    repository.UserRepository
}

// NewAuthMiddleware, constructor.
func NewAuthMiddleware(authService services.AuthService, userRepo repository.UserRepository) *AuthMiddleware {
	return &AuthMiddleware{
		authService: authService,
		userRepo:    userRepo,
	}
}

// Require, JWT token zorunlu kılan middleware.
// Token yoksa veya geçersizse → 401 Unauthorized.
//
// HTTP header formatı: Authorization: Bearer <token>
//
// Middleware nasıl çalışır?
// 1. "Authorization" header'ını oku
// 2. "Bearer " prefix'ini kaldır → raw token string
// 3. AuthService.ValidateAccessToken() ile doğrula
// 4. Token geçerliyse → kullanıcıyı DB'den getir → context'e ekle → next handler'ı çağır
// 5. Geçersizse → 401 döndür, next ÇAĞIRILMAZ
func (m *AuthMiddleware) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. Header'dan token'ı al
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "authorization header required")
			return
		}

		// 2. "Bearer " prefix'ini kaldır
		if !strings.HasPrefix(authHeader, "Bearer ") {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "invalid authorization format, use: Bearer <token>")
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		// 3. Token'ı doğrula
		claims, err := m.authService.ValidateAccessToken(tokenString)
		if err != nil {
			pkg.Error(w, err)
			return
		}

		// 4. Kullanıcıyı DB'den getir — token geçerli ama kullanıcı silinmiş olabilir
		user, err := m.userRepo.GetByID(r.Context(), claims.UserID)
		if err != nil {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found")
			return
		}

		// Password hash'i temizle — context'te taşınmamalı
		user.PasswordHash = ""

		// 5. Context'e kullanıcıyı ekle
		// context.WithValue: mevcut context'e key-value ekler.
		// Downstream handler'lar r.Context().Value(UserContextKey) ile erişir.
		ctx := context.WithValue(r.Context(), handlers.UserContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
