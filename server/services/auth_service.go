// Package services, business logic katmanını barındırır.
//
// Service Layer Pattern nedir?
// Handler (HTTP) ile Repository (DB) arasında oturan katmandır.
// Tüm iş kuralları burada yaşar:
//   - Şifre hash'leme
//   - JWT token oluşturma
//   - "İlk kullanıcı admin olsun" kuralı
//   - Yetki kontrolleri
//
// Service ASLA http.Request/Response bilmez — sadece domain modelleri alır/verir.
// Service ASLA doğrudan SQL çalıştırmaz — Repository interface'i kullanır.
package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// AuthService interface'i — dışarıya açık API.
// Handler bu interface'e bağımlıdır, concrete struct'a değil.
type AuthService interface {
	Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error)
	Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error)
	Logout(ctx context.Context, refreshToken string) error
	ValidateAccessToken(tokenString string) (*TokenClaims, error)
}

// AuthTokens, login/register sonrası dönen token çifti.
type AuthTokens struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	User         models.User `json:"user"`
}

// TokenClaims, JWT token'ın içindeki veriler (payload).
//
// JWT (JSON Web Token) nedir?
// Kullanıcı kimliğini doğrulamak için kullanılan, imzalanmış bir token.
// 3 parçadan oluşur: header.payload.signature
//
// Payload'da kullanıcı ID'si ve token'ın expire süresi bulunur.
// Server her request'te bu token'ı doğrular — DB'ye gitmeden
// kullanıcının kim olduğunu bilir.
type TokenClaims struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// authService, AuthService interface'inin implementasyonu.
// Tüm dependency'ler constructor injection ile alınır.
type authService struct {
	userRepo    repository.UserRepository
	sessionRepo repository.SessionRepository
	roleRepo    repository.RoleRepository
	jwtSecret   []byte
	accessExp   time.Duration
	refreshExp  time.Duration
}

// NewAuthService, constructor.
// jwtSecret: token imzalama anahtarı
// accessExpMinutes: access token ömrü (dakika)
// refreshExpDays: refresh token ömrü (gün)
func NewAuthService(
	userRepo repository.UserRepository,
	sessionRepo repository.SessionRepository,
	roleRepo repository.RoleRepository,
	jwtSecret string,
	accessExpMinutes int,
	refreshExpDays int,
) AuthService {
	return &authService{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		roleRepo:    roleRepo,
		jwtSecret:   []byte(jwtSecret),
		accessExp:   time.Duration(accessExpMinutes) * time.Minute,
		refreshExp:  time.Duration(refreshExpDays) * 24 * time.Hour,
	}
}

// Register, yeni kullanıcı kaydı oluşturur.
//
// İş kuralları:
// 1. Request validation
// 2. Şifreyi bcrypt ile hash'le (cost=12)
// 3. Kullanıcıyı DB'ye kaydet
// 4. İlk kullanıcı ise → Owner rolü ata, değilse → Member rolü
// 5. JWT token çifti oluştur
func (s *authService) Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error) {
	// 1. Validation
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// 2. Bcrypt hash
	// bcrypt: Şifre hash'leme algoritması. cost=12 demek 2^12 iterasyon yapılır.
	// Bu, brute-force saldırılarını yavaşlatır. Her hash benzersizdir (salt içerir),
	// aynı şifreyi iki kez hash'lesen farklı sonuç çıkar.
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	// 3. User oluştur
	var displayName *string
	if req.DisplayName != "" {
		displayName = &req.DisplayName
	}

	user := &models.User{
		Username:     req.Username,
		DisplayName:  displayName,
		PasswordHash: string(hash),
		Status:       models.UserStatusOnline,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err // ErrAlreadyExists olabilir
	}

	// 4. Rol ata — ilk kullanıcı mı?
	count, err := s.userRepo.Count(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}

	if count == 1 {
		// İlk kullanıcı → Owner rolü
		if err := s.roleRepo.AssignToUser(ctx, user.ID, "owner"); err != nil {
			return nil, fmt.Errorf("failed to assign owner role: %w", err)
		}
	} else {
		// Diğer kullanıcılar → default (Member) rolü
		defaultRole, err := s.roleRepo.GetDefault(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get default role: %w", err)
		}
		if err := s.roleRepo.AssignToUser(ctx, user.ID, defaultRole.ID); err != nil {
			return nil, fmt.Errorf("failed to assign default role: %w", err)
		}
	}

	// 5. Token çifti oluştur
	tokens, err := s.generateTokens(ctx, user)
	if err != nil {
		return nil, err
	}

	return tokens, nil
}

// Login, kullanıcı girişi yapar.
//
// İş kuralları:
// 1. Username ile kullanıcıyı bul
// 2. Bcrypt ile şifre doğrula
// 3. JWT token çifti oluştur
func (s *authService) Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Kullanıcıyı bul
	user, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			// Güvenlik: "kullanıcı bulunamadı" demek yerine generic hata döneriz.
			// Böylece saldırgan hangi username'lerin var olduğunu öğrenemez.
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	// Bcrypt şifre karşılaştırması
	// CompareHashAndPassword: hash'i çözer ve verilen şifre ile karşılaştırır.
	// Eşleşmezse hata döner. Timing-safe karşılaştırma yapar (side-channel attack koruması).
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	// Status'u online yap
	if err := s.userRepo.UpdateStatus(ctx, user.ID, models.UserStatusOnline); err != nil {
		return nil, fmt.Errorf("failed to update status: %w", err)
	}
	user.Status = models.UserStatusOnline

	return s.generateTokens(ctx, user)
}

// RefreshToken, süresi dolmuş access token'ı yenilemek için kullanılır.
//
// Akış:
// 1. Refresh token ile DB'deki session'ı bul
// 2. Expire olmuş mu kontrol et
// 3. Eski session'ı sil (rotation — çalınan token tekrar kullanılamaz)
// 4. Yeni token çifti oluştur
func (s *authService) RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error) {
	session, err := s.sessionRepo.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	// Expire kontrolü
	if time.Now().After(session.ExpiresAt) {
		// Süresi dolmuş → sil
		if delErr := s.sessionRepo.DeleteByID(ctx, session.ID); delErr != nil {
			return nil, fmt.Errorf("failed to delete expired session: %w", delErr)
		}
		return nil, fmt.Errorf("%w: refresh token expired", pkg.ErrUnauthorized)
	}

	// Token rotation: eski session'ı sil
	if err := s.sessionRepo.DeleteByID(ctx, session.ID); err != nil {
		return nil, fmt.Errorf("failed to delete old session: %w", err)
	}

	// Kullanıcıyı getir
	user, err := s.userRepo.GetByID(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	return s.generateTokens(ctx, user)
}

// Logout, refresh token'ı iptal eder (session siler).
func (s *authService) Logout(ctx context.Context, refreshToken string) error {
	session, err := s.sessionRepo.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil // Zaten yok, sorun değil
		}
		return err
	}

	// Status'u offline yap
	if err := s.userRepo.UpdateStatus(ctx, session.UserID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return s.sessionRepo.DeleteByID(ctx, session.ID)
}

// ValidateAccessToken, JWT access token'ı doğrular ve claims'i döner.
// Middleware tarafından her request'te çağrılır.
func (s *authService) ValidateAccessToken(tokenString string) (*TokenClaims, error) {
	// jwt.ParseWithClaims: Token string'ini parse edip signature'ı doğrular.
	// keyFunc: imzayı doğrulamak için kullanılacak secret'ı döner.
	token, err := jwt.ParseWithClaims(tokenString, &TokenClaims{}, func(token *jwt.Token) (any, error) {
		// Signing method kontrolü — sadece HMAC kabul ediyoruz
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("%w: invalid token", pkg.ErrUnauthorized)
	}

	claims, ok := token.Claims.(*TokenClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("%w: invalid token claims", pkg.ErrUnauthorized)
	}

	return claims, nil
}

// ─── Private Helpers ───

// generateTokens, access + refresh token çifti oluşturur.
func (s *authService) generateTokens(ctx context.Context, user *models.User) (*AuthTokens, error) {
	// Access token oluştur
	now := time.Now()
	accessClaims := &TokenClaims{
		UserID:   user.ID,
		Username: user.Username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(s.accessExp)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}

	accessToken := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims)
	accessString, err := accessToken.SignedString(s.jwtSecret)
	if err != nil {
		return nil, fmt.Errorf("failed to sign access token: %w", err)
	}

	// Refresh token oluştur — rastgele hex string
	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	refreshString := hex.EncodeToString(refreshBytes)

	// Session'ı DB'ye kaydet
	session := &models.Session{
		UserID:       user.ID,
		RefreshToken: refreshString,
		ExpiresAt:    now.Add(s.refreshExp),
	}

	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	// Password hash'i yanıta dahil etme
	user.PasswordHash = ""

	return &AuthTokens{
		AccessToken:  accessString,
		RefreshToken: refreshString,
		User:         *user,
	}, nil
}
