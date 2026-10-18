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
	"github.com/akinalp/mqvi/pkg/crypto"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/pkg/geoip"
	"github.com/akinalp/mqvi/pkg/password"
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
	Register(ctx context.Context, req *models.CreateUserRequest, client models.ClientInfo) (*AuthTokens, error)
	Login(ctx context.Context, req *models.LoginRequest, client models.ClientInfo) (*AuthTokens, error)
	RefreshToken(ctx context.Context, refreshToken string, client models.ClientInfo) (*AuthTokens, error)
	Logout(ctx context.Context, refreshToken string) error
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
	ValidateFileToken(tokenString string) (*models.TokenClaims, error)
	// ValidateSession rejects a token whose device session has been revoked, signed out or has
	// expired. Every surface that accepts a JWT calls it after the signature check. Tokens issued
	// before sessions were named in them (no sid) pass; they expire on their own.
	ValidateSession(ctx context.Context, claims *models.TokenClaims) error
	// ChangePassword signs every device out, then this one back in. currentSessionID is the
	// requesting device's session, whose connections must survive the sign-out.
	ChangePassword(ctx context.Context, userID, currentSessionID, currentPassword, newPassword string, client models.ClientInfo) (*AuthTokens, error)
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
	RestoreAccount(ctx context.Context, username, password string, client models.ClientInfo) (*AuthTokens, error)

	// RecordCredentialStoreFailure logs a desktop app that could not save or read its
	// remembered credentials. The request is validated by the handler.
	RecordCredentialStoreFailure(userID string, req *models.CredentialStoreFailureRequest)

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
	userRepo      repository.UserRepository
	sessionRepo   repository.SessionRepository
	resetRepo     repository.PasswordResetRepository // nil if email not configured
	hub           ws.EventPublisher
	emailSender   email.EmailSender // nil if RESEND_API_KEY not set
	breachChecker password.BreachChecker
	locator       geoip.Locator
	appLogger     AuthAppLogger
	jwtSecret     []byte
	encryptionKey []byte // encrypts the pending refresh token at rest
	accessExp     time.Duration
	refreshExp    time.Duration
	fileExp       time.Duration
}

// refreshGraceWindow is how long a just-rotated refresh token keeps answering with the same
// successor, so parallel refreshes (several tabs, one storage) cannot log each other out.
const refreshGraceWindow = 60 * time.Second

// rotateAttempts bounds the compare-and-swap loop; each retry means another request won a race.
const rotateAttempts = 3

func (s *authService) SetAppLogger(logger AuthAppLogger) {
	s.appLogger = logger
}

func (s *authService) RecordCredentialStoreFailure(userID string, req *models.CredentialStoreFailureRequest) {
	metadata := map[string]string{
		"operation": req.Operation,
		"reason":    req.Reason,
		"platform":  req.Platform,
	}
	if req.Backend != "" {
		metadata["backend"] = req.Backend
	}
	if req.Detail != "" {
		metadata["detail"] = req.Detail
	}
	// Operation and reason in the message: the log list is scanned by eye.
	s.logWarn(&userID, "remember-me credentials "+req.Operation+" failed: "+req.Reason+" ("+req.Platform+")", metadata)
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
	breachChecker password.BreachChecker,
	locator geoip.Locator,
	jwtSecret string,
	encryptionKey []byte,
	accessExpMinutes int,
	refreshExpDays int,
	fileExpHours int,
) AuthService {
	return &authService{
		userRepo:      userRepo,
		sessionRepo:   sessionRepo,
		resetRepo:     resetRepo,
		hub:           hub,
		emailSender:   emailSender,
		breachChecker: breachChecker,
		locator:       locator,
		jwtSecret:     []byte(jwtSecret),
		encryptionKey: encryptionKey,
		accessExp:     time.Duration(accessExpMinutes) * time.Minute,
		refreshExp:    time.Duration(refreshExpDays) * 24 * time.Hour,
		fileExp:       time.Duration(fileExpHours) * time.Hour,
	}
}

func emailOf(u *models.User) string {
	if u == nil || u.Email == nil {
		return ""
	}
	return *u.Email
}

// Coded so the client can translate the rejection rather than match on English text.
func (s *authService) checkPasswordOffline(newPassword, username, email string) error {
	switch err := password.Validate(newPassword, username, email); {
	case err == nil:
		return nil
	case errors.Is(err, password.ErrTooShort):
		return pkg.WithCode(fmt.Errorf("%w: %v", pkg.ErrBadRequest, err), pkg.CodePasswordTooShort)
	case errors.Is(err, password.ErrTooLong):
		return pkg.WithCode(fmt.Errorf("%w: %v", pkg.ErrBadRequest, err), pkg.CodePasswordTooLong)
	case errors.Is(err, password.ErrContainsIdentity):
		return pkg.WithCode(fmt.Errorf("%w: %v", pkg.ErrBadRequest, err), pkg.CodePasswordContainsIdentity)
	default:
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
}

// A lookup we cannot make allows the password — signups must not hinge on a third party being
// up — but it is logged, so an operator can see the corpus went unconsulted.
func (s *authService) checkPasswordBreached(ctx context.Context, newPassword string) error {
	if s.breachChecker == nil {
		return nil
	}

	breached, err := s.breachChecker.IsBreached(ctx, newPassword)
	if err != nil {
		s.logWarn(nil, "Password breach check unavailable, password allowed", map[string]string{
			"error": err.Error(),
		})
		return nil
	}
	if breached {
		return pkg.WithCode(
			fmt.Errorf("%w: %v", pkg.ErrBadRequest, password.ErrBreached),
			pkg.CodePasswordBreached,
		)
	}
	return nil
}

// Register creates a new user account.
// Multi-server: no server membership or role assignment at registration.
// Users join servers via invite or create their own.
func (s *authService) Register(ctx context.Context, req *models.CreateUserRequest, client models.ClientInfo) (*AuthTokens, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	if err := s.checkPasswordOffline(req.Password, req.Username, req.Email); err != nil {
		return nil, err
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

	// The 3s lookup and the deliberately-slow hash both wait until the free checks have passed.
	if err := s.checkPasswordBreached(ctx, req.Password); err != nil {
		return nil, err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
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

	tokens, err := s.generateTokens(ctx, user, client)
	if err != nil {
		return nil, err
	}

	return tokens, nil
}

// Login authenticates a user. Platform-level ban checked here; server bans checked at WS connect.
func (s *authService) Login(ctx context.Context, req *models.LoginRequest, client models.ClientInfo) (*AuthTokens, error) {
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

	return s.generateTokens(ctx, user, client)
}

// RefreshToken exchanges a refresh token for a new set. The session row is the device; only its
// token hashes rotate. Presenting the token the current one replaced is not an error — it means a
// response was lost or another tab refreshed first — but presenting anything older is treated as
// a stolen token and ends the device's session.
func (s *authService) RefreshToken(ctx context.Context, refreshToken string, client models.ClientInfo) (*AuthTokens, error) {
	session, err := s.findSession(ctx, refreshToken)
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

	presented := hashToken(refreshToken)
	for attempt := 0; attempt < rotateAttempts; attempt++ {
		switch {
		case matchesCurrent(session, refreshToken, presented):
			tokens, ok, err := s.rotate(ctx, session, user, &presented, client)
			if err != nil || ok {
				return tokens, err
			}

		case session.PrevTokenHash != nil && *session.PrevTokenHash == presented:
			if session.PendingToken != nil && session.RotatedAt != nil &&
				time.Since(*session.RotatedAt) <= refreshGraceWindow {
				pending, err := crypto.Decrypt(*session.PendingToken, s.encryptionKey)
				if err != nil {
					return nil, fmt.Errorf("failed to open pending refresh token: %w", err)
				}
				return s.issueTokens(user, session.ID, pending)
			}
			// The successor was never exchanged, so whoever holds it never received it: replace it.
			tokens, ok, err := s.rotate(ctx, session, user, session.PrevTokenHash, client)
			if err != nil || ok {
				return tokens, err
			}

		default:
			// Older than the previous token: someone kept a copy. Ending the session locks out
			// whichever side is not the owner; the owner signs in again.
			if delErr := s.sessionRepo.DeleteByID(ctx, session.ID); delErr != nil {
				return nil, fmt.Errorf("failed to revoke session after token reuse: %w", delErr)
			}
			s.logWarn(&user.ID, "Refresh token reuse detected: session revoked", map[string]string{
				"username":   user.Username,
				"session_id": session.ID,
			})
			return nil, fmt.Errorf("%w: refresh token reuse", pkg.ErrUnauthorized)
		}

		// Another request rotated between our read and our write; decide again on what it wrote.
		session, err = s.sessionRepo.GetByID(ctx, session.ID)
		if err != nil {
			if errors.Is(err, pkg.ErrNotFound) {
				return nil, fmt.Errorf("%w: invalid refresh token", pkg.ErrUnauthorized)
			}
			return nil, err
		}
	}
	return nil, fmt.Errorf("refresh token rotation kept losing to concurrent refreshes for session %s", session.ID)
}

// Logout ends the device session the token belongs to. A token that does not match the session
// it names is ignored rather than allowed to sign that device out.
func (s *authService) Logout(ctx context.Context, refreshToken string) error {
	session, err := s.findSession(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil
		}
		return err
	}

	presented := hashToken(refreshToken)
	isPrev := session.PrevTokenHash != nil && *session.PrevTokenHash == presented
	if !matchesCurrent(session, refreshToken, presented) && !isPrev {
		return nil
	}

	if err := s.userRepo.UpdateStatus(ctx, session.UserID, models.UserStatusOffline); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	return s.sessionRepo.DeleteByID(ctx, session.ID)
}

// findSession resolves a refresh token to its session: by the embedded session ID, or for a
// pre-098 token by the plaintext value (or its hash, once converted).
func (s *authService) findSession(ctx context.Context, refreshToken string) (*models.Session, error) {
	if sid, ok := sessionIDOf(refreshToken); ok {
		return s.sessionRepo.GetByID(ctx, sid)
	}
	return s.sessionRepo.GetByLegacyToken(ctx, refreshToken, hashToken(refreshToken))
}

func matchesCurrent(session *models.Session, raw, hash string) bool {
	if session.TokenHash != nil && *session.TokenHash == hash {
		return true
	}
	return session.LegacyToken != nil && *session.LegacyToken == raw
}

// rotate issues a successor for session. ok=false means another request rotated first and the
// caller must re-read the row.
func (s *authService) rotate(ctx context.Context, session *models.Session, user *models.User, prevHash *string, client models.ClientInfo) (*AuthTokens, bool, error) {
	next, err := newRefreshToken(session.ID)
	if err != nil {
		return nil, false, err
	}
	encrypted, err := crypto.Encrypt(next, s.encryptionKey)
	if err != nil {
		return nil, false, fmt.Errorf("failed to encrypt refresh token: %w", err)
	}

	now := time.Now()
	ok, err := s.sessionRepo.Rotate(ctx, session, models.SessionRotation{
		TokenHash:     hashToken(next),
		PrevTokenHash: prevHash,
		PendingToken:  &encrypted,
		RotatedAt:     now,
		ExpiresAt:     now.Add(s.refreshExp),
		Client:        s.sessionClient(client),
	})
	if err != nil || !ok {
		return nil, false, err
	}

	tokens, err := s.issueTokens(user, session.ID, next)
	return tokens, err == nil, err
}

func (s *authService) ValidateAccessToken(tokenString string) (*models.TokenClaims, error) {
	return s.validateToken(tokenString, models.AudienceAPI)
}

func (s *authService) ValidateFileToken(tokenString string) (*models.TokenClaims, error) {
	return s.validateToken(tokenString, models.AudienceFile)
}

func (s *authService) ValidateSession(ctx context.Context, claims *models.TokenClaims) error {
	if claims.SessionID == "" {
		return nil
	}
	session, err := s.sessionRepo.GetByID(ctx, claims.SessionID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: session revoked", pkg.ErrUnauthorized)
		}
		return fmt.Errorf("failed to check session: %w", err)
	}
	if session.UserID != claims.UserID || time.Now().After(session.ExpiresAt) {
		return fmt.Errorf("%w: session revoked", pkg.ErrUnauthorized)
	}
	return nil
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

func (s *authService) ChangePassword(ctx context.Context, userID, currentSessionID, currentPassword, newPassword string, client models.ClientInfo) (*AuthTokens, error) {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	// Proving the current password comes first: an attacker on a hijacked session should not
	// be able to probe the breach corpus, and a stranger should learn nothing from the errors.
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		return nil, fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}

	if currentPassword == newPassword {
		return nil, fmt.Errorf("%w: new password must be different from current password", pkg.ErrBadRequest)
	}

	if err := s.checkPasswordOffline(newPassword, user.Username, emailOf(user)); err != nil {
		return nil, err
	}
	if err := s.checkPasswordBreached(ctx, newPassword); err != nil {
		return nil, err
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
	tokens, err := s.generateTokens(ctx, user, client)
	if err != nil {
		return nil, err
	}
	// UpdatePassword deleted every session; the devices still connected must hear it now, not
	// when their next request fails. This device's open sockets still carry its old sid.
	if s.hub != nil {
		if sid, ok := sessionIDOf(tokens.RefreshToken); ok {
			s.hub.RevokeAuthSessionsExcept(userID, sid, currentSessionID)
		}
	}
	return tokens, nil
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
func (s *authService) RestoreAccount(ctx context.Context, username, password string, client models.ClientInfo) (*AuthTokens, error) {
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

	return s.generateTokens(ctx, user, client)
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

	// Held back until the token proves out, so the policy is checked against the real account
	// and an invalid token cannot be used to probe the breach corpus.
	user, err := s.userRepo.GetByID(ctx, resetToken.UserID)
	if err != nil {
		// The account went away under a live token. The write below answered this with the
		// same "invalid token" it gives any other dead token; keep it that way rather than
		// leaking a 404 that says the token was real but the user is not.
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to load user for reset: %w", err)
	}
	if err := s.checkPasswordOffline(newPassword, user.Username, emailOf(user)); err != nil {
		return err
	}
	if err := s.checkPasswordBreached(ctx, newPassword); err != nil {
		return err
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

// generateTokens starts a new device session for user and returns its first token set.
func (s *authService) generateTokens(ctx context.Context, user *models.User, client models.ClientInfo) (*AuthTokens, error) {
	sidBytes := make([]byte, 8)
	if _, err := rand.Read(sidBytes); err != nil {
		return nil, fmt.Errorf("failed to generate session id: %w", err)
	}
	sid := hex.EncodeToString(sidBytes)

	refresh, err := newRefreshToken(sid)
	if err != nil {
		return nil, err
	}
	refreshHash := hashToken(refresh)

	session := &models.Session{
		ID:        sid,
		UserID:    user.ID,
		TokenHash: &refreshHash,
		ExpiresAt: time.Now().Add(s.refreshExp),
		Client:    s.sessionClient(client),
	}
	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	return s.issueTokens(user, sid, refresh)
}

// issueTokens signs a fresh access and file token for an existing session and pairs them with
// that session's refresh token.
func (s *authService) issueTokens(user *models.User, sid, refreshToken string) (*AuthTokens, error) {
	now := time.Now()

	accessString, err := s.signJWT(user, sid, models.AudienceAPI, now, s.accessExp)
	if err != nil {
		return nil, fmt.Errorf("failed to sign access token: %w", err)
	}
	fileString, err := s.signJWT(user, sid, models.AudienceFile, now, s.fileExp)
	if err != nil {
		return nil, fmt.Errorf("failed to sign file token: %w", err)
	}

	user.PasswordHash = ""

	return &AuthTokens{
		AccessToken:  accessString,
		RefreshToken: refreshToken,
		FileToken:    fileString,
		User:         *user,
	}, nil
}

func (s *authService) signJWT(user *models.User, sid, audience string, now time.Time, ttl time.Duration) (string, error) {
	claims := &models.TokenClaims{
		UserID:       user.ID,
		Username:     user.Username,
		TokenVersion: user.TokenVersion,
		SessionID:    sid,
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "mqvi",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
}

// sessionClient is what gets stored about the device: normalised client claims plus the place its
// address resolves to. An empty value stays nil so a refresh cannot overwrite a known one with "".
func (s *authService) sessionClient(c models.ClientInfo) models.SessionClient {
	c = c.Normalized()
	var city, country string
	if s.locator != nil {
		city, country = s.locator.Lookup(c.IP)
	}
	return models.SessionClient{
		Platform:    nonEmpty(c.Platform),
		DeviceLabel: nonEmpty(c.DeviceLabel),
		IP:          nonEmpty(c.IP),
		City:        nonEmpty(city),
		Country:     nonEmpty(country),
	}
}

func nonEmpty(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// Refresh tokens are "<session id>.<secret>": the ID locates the device even when the secret is
// stale, which is what lets a replayed old token be recognised and its session ended.
func newRefreshToken(sid string) (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("failed to generate refresh token: %w", err)
	}
	return sid + "." + hex.EncodeToString(secret), nil
}

func sessionIDOf(refreshToken string) (string, bool) {
	sid, secret, found := strings.Cut(refreshToken, ".")
	return sid, found && sid != "" && secret != ""
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
