// Package services, business logic katmanını barındırır.
//
// Service Layer Pattern nedir?
// Handler (HTTP) ile Repository (DB) arasında oturan katmandır.
// Tüm iş kuralları burada yaşar:
//   - Şifre hash'leme
//   - JWT token oluşturma
//   - Yetki kontrolleri
//
// Service ASLA http.Request/Response bilmez — sadece domain modelleri alır/verir.
// Service ASLA doğrudan SQL çalıştırmaz — Repository interface'i kullanır.
package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/ws"
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
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
	// ChangePassword, kullanıcının şifresini değiştirir.
	ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error
	// ChangeEmail, kullanıcının email adresini değiştirir.
	ChangeEmail(ctx context.Context, userID, password, newEmail string) error

	// ForgotPassword, kullanıcıya şifre sıfırlama emaili gönderir.
	// Email DB'de yoksa bile hata vermez (email enumeration koruması).
	// Cooldown: aynı email'e 90 saniyede 1 istek.
	// cooldownRemaining > 0 ise kalan süreyi döner.
	ForgotPassword(ctx context.Context, email string) (cooldownRemaining int, err error)

	// ResetPassword, token ile şifre sıfırlar.
	// Token doğrulanır, şifre güncellenir, token silinir.
	ResetPassword(ctx context.Context, token, newPassword string) error
}

// AuthTokens, login/register sonrası dönen token çifti.
type AuthTokens struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	User         models.User `json:"user"`
}

// authService, AuthService interface'inin implementasyonu.
type authService struct {
	userRepo    repository.UserRepository
	sessionRepo repository.SessionRepository
	resetRepo   repository.PasswordResetRepository // nil olabilir — email yoksa reset devre dışı
	hub         ws.EventPublisher
	emailSender email.EmailSender // nil olabilir — RESEND_API_KEY yoksa feature devre dışı
	jwtSecret   []byte
	accessExp   time.Duration
	refreshExp  time.Duration
}

// NewAuthService, constructor.
//
// Multi-server mimarisinde Register artık hiçbir sunucuya üye eklemez.
// Kullanıcı kayıt olduktan sonra sunuculara invite ile katılır veya yeni sunucu oluşturur.
// Ban kontrolü de sunucu bazlı olduğu için Login'den kaldırıldı.
func NewAuthService(
	userRepo repository.UserRepository,
	sessionRepo repository.SessionRepository,
	resetRepo repository.PasswordResetRepository,
	hub ws.EventPublisher,
	emailSender email.EmailSender,
	jwtSecret string,
	accessExpMinutes int,
	refreshExpDays int,
) AuthService {
	return &authService{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		resetRepo:   resetRepo,
		hub:         hub,
		emailSender: emailSender,
		jwtSecret:   []byte(jwtSecret),
		accessExp:   time.Duration(accessExpMinutes) * time.Minute,
		refreshExp:  time.Duration(refreshExpDays) * 24 * time.Hour,
	}
}

// Register, yeni kullanıcı kaydı oluşturur.
//
// Multi-server mimarisinde değişiklikler:
// - Invite code kontrolü KALDIRILDI — kayıt sunucu bağımsız
// - Rol ataması KALDIRILDI — roller sunucu bazlı, sunucuya katılınca atanır
// - member_join broadcast KALDIRILDI — sunucu üyeliği kayıt sırasında yok
//
// Kullanıcı kayıt olunca boş bir hesap oluşur. Sunuculara katılım
// ServerService.JoinServer veya CreateServer ile yapılır.
func (s *authService) Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error) {
	// 1. Validation
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// 2. Bcrypt hash (cost=12)
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	// 3. User oluştur
	var displayName *string
	if req.DisplayName != "" {
		displayName = &req.DisplayName
	}

	var email *string
	if req.Email != "" {
		email = &req.Email
	}

	user := &models.User{
		Username:     req.Username,
		DisplayName:  displayName,
		Email:        email,
		PasswordHash: string(hash),
		Status:       models.UserStatusOnline,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err // ErrAlreadyExists olabilir
	}

	// 4. Token çifti oluştur
	tokens, err := s.generateTokens(ctx, user)
	if err != nil {
		return nil, err
	}

	return tokens, nil
}

// Login, kullanıcı girişi yapar.
//
// Multi-server mimarisinde ban kontrolü kaldırıldı — ban sunucu bazlıdır.
// Banlı bir kullanıcı diğer sunucularını kullanabilir.
func (s *authService) Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// Kullanıcıyı bul
	user, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	// Bcrypt şifre karşılaştırması
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
func (s *authService) RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error) {
	session, err := s.sessionRepo.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if time.Now().After(session.ExpiresAt) {
		if delErr := s.sessionRepo.DeleteByID(ctx, session.ID); delErr != nil {
			return nil, fmt.Errorf("failed to delete expired session: %w", delErr)
		}
		return nil, fmt.Errorf("%w: refresh token expired", pkg.ErrUnauthorized)
	}

	if err := s.sessionRepo.DeleteByID(ctx, session.ID); err != nil {
		return nil, fmt.Errorf("failed to delete old session: %w", err)
	}

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
			return nil
		}
		return err
	}

	if err := s.userRepo.UpdateStatus(ctx, session.UserID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return s.sessionRepo.DeleteByID(ctx, session.ID)
}

// ValidateAccessToken, JWT access token'ı doğrular ve claims'i döner.
func (s *authService) ValidateAccessToken(tokenString string) (*models.TokenClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &models.TokenClaims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("%w: invalid token", pkg.ErrUnauthorized)
	}

	claims, ok := token.Claims.(*models.TokenClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("%w: invalid token claims", pkg.ErrUnauthorized)
	}

	return claims, nil
}

// ChangePassword, kullanıcının şifresini değiştirir.
func (s *authService) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	if len(newPassword) < 6 {
		return fmt.Errorf("%w: password must be at least 6 characters", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		return fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}

	if currentPassword == newPassword {
		return fmt.Errorf("%w: new password must be different from current password", pkg.ErrBadRequest)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	return s.userRepo.UpdatePassword(ctx, userID, string(newHash))
}

// ChangeEmail, kullanıcının email adresini değiştirir.
func (s *authService) ChangeEmail(ctx context.Context, userID, password, newEmail string) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return fmt.Errorf("%w: password is incorrect", pkg.ErrUnauthorized)
	}

	if strings.TrimSpace(newEmail) == "" {
		if user.Email == nil {
			return fmt.Errorf("%w: no email to remove", pkg.ErrBadRequest)
		}
		return s.userRepo.UpdateEmail(ctx, userID, nil)
	}

	newEmail = strings.TrimSpace(newEmail)
	if !models.EmailRegex().MatchString(newEmail) {
		return fmt.Errorf("%w: invalid email format", pkg.ErrBadRequest)
	}

	if user.Email != nil && *user.Email == newEmail {
		return fmt.Errorf("%w: new email is the same as current email", pkg.ErrBadRequest)
	}

	return s.userRepo.UpdateEmail(ctx, userID, &newEmail)
}

// ─── Password Reset ───

// resetCooldown, aynı kullanıcının arka arkaya reset emaili almasını engeller.
// 90 saniye — spam koruması.
const resetCooldown = 90 * time.Second

// resetTokenExpiry, şifre sıfırlama token'ının geçerlilik süresi.
const resetTokenExpiry = 20 * time.Minute

// ForgotPassword, şifre sıfırlama emaili gönderir.
//
// Güvenlik kararları:
// 1. Email DB'de yoksa bile aynı success yanıtı döner — saldırgan hangi email'lerin
//    kayıtlı olduğunu tespit edemez (email enumeration koruması).
// 2. Token plaintext olarak email'e gömülür, DB'de SHA256 hash saklanır.
// 3. Cooldown: aynı email'e 90 saniyede 1 istek (spam engeli).
//    cooldownRemaining > 0 ise kalan saniyeyi döner.
func (s *authService) ForgotPassword(ctx context.Context, emailAddr string) (int, error) {
	// Email özelliği devre dışıysa (RESEND_API_KEY yoksa)
	if s.emailSender == nil || s.resetRepo == nil {
		return 0, fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	// Kullanıcıyı email'e göre bul
	user, err := s.userRepo.GetByEmail(ctx, emailAddr)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			// Email enumeration koruması: email yoksa da success gibi davran.
			// Ama cooldown dönemeyiz çünkü user yok — 0 dön.
			return 0, nil
		}
		return 0, fmt.Errorf("failed to look up user: %w", err)
	}

	// Cooldown kontrolü: son token'ın oluşturulma zamanına bak
	lastToken, err := s.resetRepo.GetLatestByUserID(ctx, user.ID)
	if err == nil {
		// Token var — cooldown doldu mu?
		elapsed := time.Since(lastToken.CreatedAt)
		if elapsed < resetCooldown {
			remaining := int((resetCooldown - elapsed).Seconds())
			if remaining < 1 {
				remaining = 1
			}
			return remaining, nil
		}
	}
	// err != nil → token yok (ErrNotFound) veya DB hatası — devam et

	// Eski tokenları temizle (bu kullanıcı için)
	if delErr := s.resetRepo.DeleteByUserID(ctx, user.ID); delErr != nil {
		log.Printf("[auth] warning: failed to delete old reset tokens for user %s: %v", user.ID, delErr)
	}

	// Süresi dolmuş tüm tokenları temizle (fırsat temizliği)
	if delErr := s.resetRepo.DeleteExpired(ctx); delErr != nil {
		log.Printf("[auth] warning: failed to delete expired reset tokens: %v", delErr)
	}

	// Yeni token üret (32 byte = 64 hex karakter)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return 0, fmt.Errorf("failed to generate reset token: %w", err)
	}
	plainToken := hex.EncodeToString(tokenBytes)

	// SHA256 hash — DB'de plaintext saklanmaz
	hashBytes := sha256.Sum256([]byte(plainToken))
	tokenHash := hex.EncodeToString(hashBytes[:])

	// DB'ye kaydet
	resetToken := &models.PasswordResetToken{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(resetTokenExpiry),
	}
	if err := s.resetRepo.Create(ctx, resetToken); err != nil {
		return 0, fmt.Errorf("failed to store reset token: %w", err)
	}

	// Email gönder (plaintext token email'e gömülür)
	if err := s.emailSender.SendPasswordReset(ctx, emailAddr, plainToken); err != nil {
		return 0, fmt.Errorf("failed to send reset email: %w", err)
	}

	log.Printf("[auth] password reset email sent to user %s", user.ID)
	return 0, nil
}

// ResetPassword, token ile şifre sıfırlar.
//
// Akış:
// 1. Gelen plaintext token'ı SHA256 hash'le
// 2. Hash ile DB'den token kaydını bul
// 3. Süresi dolmuş mu kontrol et
// 4. Yeni şifreyi bcrypt ile hash'le
// 5. Kullanıcının şifresini güncelle
// 6. Token'ı sil (one-time use)
func (s *authService) ResetPassword(ctx context.Context, token, newPassword string) error {
	if s.resetRepo == nil {
		return fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	if len(newPassword) < 8 {
		return fmt.Errorf("%w: password must be at least 8 characters", pkg.ErrBadRequest)
	}

	// Token'ı hash'le ve DB'de ara
	hashBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken, err := s.resetRepo.GetByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to look up reset token: %w", err)
	}

	// Süre kontrolü
	if time.Now().After(resetToken.ExpiresAt) {
		// Süresi dolmuş — token'ı sil ve hata ver
		if delErr := s.resetRepo.DeleteByID(ctx, resetToken.ID); delErr != nil {
			log.Printf("[auth] warning: failed to delete expired token %s: %v", resetToken.ID, delErr)
		}
		return fmt.Errorf("%w: reset token has expired", pkg.ErrBadRequest)
	}

	// Yeni şifreyi hash'le (bcrypt cost=12)
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	// Şifreyi güncelle
	if err := s.userRepo.UpdatePassword(ctx, resetToken.UserID, string(newHash)); err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	// Token'ı sil (one-time use) + bu kullanıcının diğer tokenlarını da temizle
	if err := s.resetRepo.DeleteByUserID(ctx, resetToken.UserID); err != nil {
		log.Printf("[auth] warning: failed to delete reset tokens for user %s: %v", resetToken.UserID, err)
	}

	log.Printf("[auth] password reset completed for user %s", resetToken.UserID)
	return nil
}

// ─── Private Helpers ───

func (s *authService) generateTokens(ctx context.Context, user *models.User) (*AuthTokens, error) {
	now := time.Now()
	accessClaims := &models.TokenClaims{
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

	refreshBytes := make([]byte, 32)
	if _, err := rand.Read(refreshBytes); err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	refreshString := hex.EncodeToString(refreshBytes)

	session := &models.Session{
		UserID:       user.ID,
		RefreshToken: refreshString,
		ExpiresAt:    now.Add(s.refreshExp),
	}

	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	user.PasswordHash = ""

	return &AuthTokens{
		AccessToken:  accessString,
		RefreshToken: refreshString,
		User:         *user,
	}, nil
}
