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
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
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
	hub         ws.EventPublisher
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
	hub ws.EventPublisher,
	jwtSecret string,
	accessExpMinutes int,
	refreshExpDays int,
) AuthService {
	return &authService{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		hub:         hub,
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
