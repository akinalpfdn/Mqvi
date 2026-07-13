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

// AuthAppLogger writes structured logs. ISP to avoid circular dependency.
type AuthAppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

type AuthService interface {
	Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error)
	Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthTokens, error)
	Logout(ctx context.Context, refreshToken string) error
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
	ValidateFileToken(tokenString string) (*models.TokenClaims, error)
	ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) (*AuthTokens, error)
	ChangeEmail(ctx context.Context, userID, password, newEmail string) error

	// ForgotPassword sends a password reset email.
	// Returns silently if email doesn't exist (email enumeration protection).
	// Cooldown: 1 request per 90s per email. cooldownRemaining > 0 = seconds left.
	ForgotPassword(ctx context.Context, email string) (cooldownRemaining int, err error)

	// ResetPassword validates token, updates password, and deletes token (one-time use).
	ResetPassword(ctx context.Context, token, newPassword string) error

	// SoftDeleteSelf marks the user soft-deleted after password verification.
	// Sessions/realtime connections are disconnected by the caller (handler).
	// Recoverable for SoftDeleteTTLDays via login flow.
	SoftDeleteSelf(ctx context.Context, userID, password string) error

	// RestoreAccount un-soft-deletes the user after password verification.
	// Returns auth tokens like a regular login. Tombstone (is_hard_deleted=1) is not recoverable.
	RestoreAccount(ctx context.Context, username, password string) (*AuthTokens, error)

	SetAppLogger(logger AuthAppLogger)
}

// AccountDeletedError signals that login was attempted on a soft-deleted account.
// The handler returns 403 with the deletion timestamp so the frontend can show
// the recovery UI.
type AccountDeletedError struct {
	UserID            string
	Username          string
	DeletedAt         string
	PermanentDeleteAt string
}

func (e *AccountDeletedError) Error() string {
	return "account is soft-deleted; recovery available"
}

type AuthTokens struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	FileToken    string      `json:"file_token"`
	User         models.User `json:"user"`
}

type authService struct {
	userRepo    repository.UserRepository
	sessionRepo repository.SessionRepository
	resetRepo   repository.PasswordResetRepository // nil if email not configured
	hub         ws.EventPublisher
	emailSender email.EmailSender // nil if RESEND_API_KEY not set
	appLogger   AuthAppLogger
	jwtSecret   []byte
	accessExp   time.Duration
	refreshExp  time.Duration
}

func (s *authService) SetAppLogger(logger AuthAppLogger) {
	s.appLogger = logger
}

func (s *authService) logWarn(userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(models.LogLevelWarn, models.LogCategoryAuth, userID, nil, message, metadata)
	}
}

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

// Register creates a new user account.
// Multi-server: no server membership or role assignment at registration.
// Users join servers via invite or create their own.
func (s *authService) Register(ctx context.Context, req *models.CreateUserRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	var displayName *string
	if req.DisplayName != "" {
		displayName = &req.DisplayName
	}

	var email *string
	if req.Email != "" {
		email = &req.Email

		// Prevent banned users from re-registering with the same email
		banned, banErr := s.userRepo.IsEmailPlatformBanned(ctx, req.Email)
		if banErr != nil {
			return nil, fmt.Errorf("failed to check email ban: %w", banErr)
		}
		if banned {
			return nil, fmt.Errorf("%w: this email is not allowed", pkg.ErrForbidden)
		}
	}

	// Prevent banned users from re-registering with the same username
	usernameBanned, ubErr := s.userRepo.IsUsernamePlatformBanned(ctx, req.Username)
	if ubErr != nil {
		return nil, fmt.Errorf("failed to check username ban: %w", ubErr)
	}
	if usernameBanned {
		return nil, fmt.Errorf("%w: this username is not allowed", pkg.ErrForbidden)
	}

	user := &models.User{
		Username:     req.Username,
		DisplayName:  displayName,
		Email:        email,
		PasswordHash: string(hash),
		Status:       models.UserStatusOnline,
		Language:     req.Language,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err
	}

	tokens, err := s.generateTokens(ctx, user)
	if err != nil {
		return nil, err
	}

	return tokens, nil
}

// Login authenticates a user. Platform-level ban checked here; server bans checked at WS connect.
func (s *authService) Login(ctx context.Context, req *models.LoginRequest) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	user, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	// Tombstone (is_hard_deleted) users have empty password_hash so bcrypt rejects.
	// Belt-and-suspenders: also reject if hash is empty.
	if user.PasswordHash == "" {
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		s.logWarn(&user.ID, "Login failed: invalid password", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if user.IsPlatformBanned {
		s.logWarn(&user.ID, "Login blocked: account suspended", map[string]string{
			"username": req.Username,
		})
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}

	// Soft-deleted (recoverable) account — surface a recovery offer to the frontend.
	if user.DeletedAt != nil && !user.IsHardDeleted {
		s.logWarn(&user.ID, "Login attempt on soft-deleted account", map[string]string{
			"username": req.Username,
		})
		permanentDeleteAt := user.DeletedAt.AddDate(0, 0, models.SoftDeleteTTLDays)
		return nil, &AccountDeletedError{
			UserID:            user.ID,
			Username:          user.Username,
			DeletedAt:         user.DeletedAt.UTC().Format("2006-01-02T15:04:05Z"),
			PermanentDeleteAt: permanentDeleteAt.UTC().Format("2006-01-02T15:04:05Z"),
		}
	}

	if err := s.userRepo.UpdateStatus(ctx, user.ID, models.UserStatusOnline); err != nil {
		return nil, fmt.Errorf("failed to update status: %w", err)
	}
	user.Status = models.UserStatusOnline

	return s.generateTokens(ctx, user)
}

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

	if user.IsPlatformBanned {
		s.logWarn(&user.ID, "Token refresh blocked: account suspended", map[string]string{
			"username": user.Username,
		})
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}

	// Soft-deleted/tombstone accounts cannot refresh — must go through login + recovery.
	if user.DeletedAt != nil {
		return nil, fmt.Errorf("%w: account deleted", pkg.ErrUnauthorized)
	}

	return s.generateTokens(ctx, user)
}

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

func (s *authService) ValidateAccessToken(tokenString string) (*models.TokenClaims, error) {
	return s.validateToken(tokenString, models.AudienceAPI)
}

func (s *authService) ValidateFileToken(tokenString string) (*models.TokenClaims, error) {
	return s.validateToken(tokenString, models.AudienceFile)
}

func (s *authService) validateToken(tokenString, requiredAud string) (*models.TokenClaims, error) {
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

	if len(claims.Audience) == 0 {
		return nil, fmt.Errorf("%w: token has no audience", pkg.ErrUnauthorized)
	}
	for _, a := range claims.Audience {
		if a == requiredAud {
			return claims, nil
		}
	}
	return nil, fmt.Errorf("%w: wrong token audience", pkg.ErrUnauthorized)
}

func (s *authService) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) (*AuthTokens, error) {
	if len(newPassword) < 6 {
		return nil, fmt.Errorf("%w: password must be at least 6 characters", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		return nil, fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}

	if currentPassword == newPassword {
		return nil, fmt.Errorf("%w: new password must be different from current password", pkg.ErrBadRequest)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash new password: %w", err)
	}

	newTV, err := s.userRepo.UpdatePassword(ctx, userID, user.PasswordHash, string(newHash))
	if err != nil {
		return nil, err
	}
	user.TokenVersion = newTV
	user.PasswordHash = string(newHash)
	return s.generateTokens(ctx, user)
}

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

	banned, banErr := s.userRepo.IsEmailPlatformBanned(ctx, newEmail)
	if banErr != nil {
		return fmt.Errorf("failed to check email ban: %w", banErr)
	}
	if banned {
		return fmt.Errorf("%w: this email is not allowed", pkg.ErrForbidden)
	}

	return s.userRepo.UpdateEmail(ctx, userID, &newEmail)
}

// SoftDeleteSelf marks the current user soft-deleted after password verification.
// Recoverable via login flow within SoftDeleteTTLDays. Caller is responsible for
// disconnecting realtime sessions and invalidating refresh tokens.
func (s *authService) SoftDeleteSelf(ctx context.Context, userID, password string) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if user.PasswordHash == "" {
		return fmt.Errorf("%w: account not eligible for self-delete", pkg.ErrForbidden)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return fmt.Errorf("%w: password is incorrect", pkg.ErrUnauthorized)
	}

	if user.DeletedAt != nil {
		return fmt.Errorf("%w: account is already deleted", pkg.ErrBadRequest)
	}

	if err := s.userRepo.SoftDelete(ctx, userID, false); err != nil {
		return fmt.Errorf("failed to soft delete account: %w", err)
	}

	// Invalidate all sessions so existing refresh tokens cannot be used.
	if err := s.sessionRepo.DeleteByUserID(ctx, userID); err != nil {
		log.Printf("[auth] failed to delete sessions for soft-deleted user %s: %v", userID, err)
	}

	// Disconnect realtime WS connections.
	if s.hub != nil {
		s.hub.DisconnectUser(userID)
	}

	return nil
}

// RestoreAccount un-soft-deletes the user after username + password verification
// and returns auth tokens (so the user is logged in immediately).
// Tombstone (is_hard_deleted=1) is not recoverable.
func (s *authService) RestoreAccount(ctx context.Context, username, password string) (*AuthTokens, error) {
	user, err := s.userRepo.GetByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
		}
		return nil, err
	}

	if user.PasswordHash == "" || user.IsHardDeleted {
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, fmt.Errorf("%w: invalid username or password", pkg.ErrUnauthorized)
	}

	if user.IsPlatformBanned {
		return nil, fmt.Errorf("%w: account suspended", pkg.ErrForbidden)
	}

	if user.DeletedAt == nil {
		return nil, fmt.Errorf("%w: account is not deleted", pkg.ErrBadRequest)
	}

	// Admin-initiated soft-delete is moderation: only admin can restore.
	// Otherwise users could undo admin actions through the recovery flow.
	if user.DeletedByAdmin {
		return nil, fmt.Errorf("%w: account was deleted by an admin and cannot be restored via login", pkg.ErrForbidden)
	}

	if err := s.userRepo.Restore(ctx, user.ID); err != nil {
		return nil, fmt.Errorf("failed to restore account: %w", err)
	}

	user.DeletedAt = nil
	user.DeletedByAdmin = false

	if err := s.userRepo.UpdateStatus(ctx, user.ID, models.UserStatusOnline); err != nil {
		return nil, fmt.Errorf("failed to update status: %w", err)
	}
	user.Status = models.UserStatusOnline

	return s.generateTokens(ctx, user)
}

// ─── Password Reset ───

const resetCooldown = 90 * time.Second
const resetTokenExpiry = 20 * time.Minute

// ForgotPassword sends a reset email. Token stored as SHA256 hash in DB.
// Email enumeration protection: returns success even if email not found.
func (s *authService) ForgotPassword(ctx context.Context, emailAddr string) (int, error) {
	if s.emailSender == nil || s.resetRepo == nil {
		return 0, fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByEmail(ctx, emailAddr)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return 0, nil
		}
		return 0, fmt.Errorf("failed to look up user: %w", err)
	}

	// Cooldown check
	lastToken, err := s.resetRepo.GetLatestByUserID(ctx, user.ID)
	if err == nil {
		elapsed := time.Since(lastToken.CreatedAt)
		if elapsed < resetCooldown {
			remaining := int((resetCooldown - elapsed).Seconds())
			if remaining < 1 {
				remaining = 1
			}
			return remaining, nil
		}
	}

	// Clean up old tokens for this user
	if delErr := s.resetRepo.DeleteByUserID(ctx, user.ID); delErr != nil {
		log.Printf("[auth] warning: failed to delete old reset tokens for user %s: %v", user.ID, delErr)
	}

	// Opportunistic cleanup of all expired tokens
	if delErr := s.resetRepo.DeleteExpired(ctx); delErr != nil {
		log.Printf("[auth] warning: failed to delete expired reset tokens: %v", delErr)
	}

	// Generate token (32 bytes = 64 hex chars)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return 0, fmt.Errorf("failed to generate reset token: %w", err)
	}
	plainToken := hex.EncodeToString(tokenBytes)

	// Store SHA256 hash in DB
	hashBytes := sha256.Sum256([]byte(plainToken))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken := &models.PasswordResetToken{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(resetTokenExpiry),
	}
	if err := s.resetRepo.Create(ctx, resetToken); err != nil {
		return 0, fmt.Errorf("failed to store reset token: %w", err)
	}

	// Send email with plaintext token
	if err := s.emailSender.SendPasswordReset(ctx, emailAddr, plainToken); err != nil {
		return 0, fmt.Errorf("failed to send reset email: %w", err)
	}

	log.Printf("[auth] password reset email sent to user %s", user.ID)
	return 0, nil
}

// ResetPassword validates the token, updates the password, and deletes all tokens for the user.
func (s *authService) ResetPassword(ctx context.Context, token, newPassword string) error {
	if s.resetRepo == nil {
		return fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	if len(newPassword) < 8 {
		return fmt.Errorf("%w: password must be at least 8 characters", pkg.ErrBadRequest)
	}

	hashBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken, err := s.resetRepo.GetByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to look up reset token: %w", err)
	}

	if time.Now().After(resetToken.ExpiresAt) {
		if delErr := s.resetRepo.DeleteByID(ctx, resetToken.ID); delErr != nil {
			log.Printf("[auth] warning: failed to delete expired token %s: %v", resetToken.ID, delErr)
		}
		return fmt.Errorf("%w: reset token has expired", pkg.ErrBadRequest)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	if _, err := s.userRepo.ResetPasswordWithToken(ctx, resetToken.UserID, resetToken.ID, string(newHash)); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to update password: %w", err)
	}

	log.Printf("[auth] password reset completed for user %s", resetToken.UserID)
	return nil
}

// ─── Private Helpers ───

func (s *authService) generateTokens(ctx context.Context, user *models.User) (*AuthTokens, error) {
	now := time.Now()

	accessString, err := s.signJWT(user, models.AudienceAPI, now, s.accessExp)
	if err != nil {
		return nil, fmt.Errorf("failed to sign access token: %w", err)
	}
	fileString, err := s.signJWT(user, models.AudienceFile, now, s.refreshExp)
	if err != nil {
		return nil, fmt.Errorf("failed to sign file token: %w", err)
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
		FileToken:    fileString,
		User:         *user,
	}, nil
}

func (s *authService) signJWT(user *models.User, audience string, now time.Time, ttl time.Duration) (string, error) {
	claims := &models.TokenClaims{
		UserID:       user.ID,
		Username:     user.Username,
		TokenVersion: user.TokenVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}
