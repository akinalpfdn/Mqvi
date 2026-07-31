package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// UserRepository defines data access for users.
type UserRepository interface {
	Create(ctx context.Context, user *models.User) error
	// GetByID returns the user including soft-deleted/tombstone state.
	// Use GetActiveByID for paths where deleted users must be invisible (login, refresh).
	GetByID(ctx context.Context, id string) (*models.User, error)
	// GetActiveByID returns the user only if deleted_at IS NULL (not soft-deleted, not tombstone).
	GetActiveByID(ctx context.Context, id string) (*models.User, error)
	// GetByUsername returns the user including soft-deleted/tombstone state.
	// Tombstones have username=deleted_<id> so their original username is naturally freed.
	GetByUsername(ctx context.Context, username string) (*models.User, error)
	// GetActiveByUsername returns the user only if deleted_at IS NULL.
	GetActiveByUsername(ctx context.Context, username string) (*models.User, error)
	// GetServerMembers returns the active members of one server, ordered by username.
	// Only the columns a member roster renders — notably not password_hash.
	GetServerMembers(ctx context.Context, serverID string) ([]models.User, error)
	Update(ctx context.Context, user *models.User) error
	UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error
	UpdatePrefStatus(ctx context.Context, userID string, prefStatus models.UserStatus) error
	// UpdatePassword writes the password, bumps token_version, and revokes all sessions.
	// oldPasswordHash guards user-initiated changes; a mismatch returns pkg.ErrConflict.
	// Empty oldPasswordHash skips that guard for already-authorized reset/admin flows.
	UpdatePassword(ctx context.Context, userID, oldPasswordHash, newPasswordHash string) (newTokenVersion int, err error)
	// ResetPasswordWithToken atomically consumes one unexpired reset token, updates the
	// password, bumps token_version, revokes sessions, and clears all reset tokens for the user.
	ResetPasswordWithToken(ctx context.Context, userID, resetTokenID, newPasswordHash string) (newTokenVersion int, err error)
	// UpdateEmail sets or clears the user's email. nil removes, *string sets.
	UpdateEmail(ctx context.Context, userID string, email *string) error
	UpdateWallpaper(ctx context.Context, userID string, wallpaperURL *string) error
	GetByEmail(ctx context.Context, email string) (*models.User, error)
	Count(ctx context.Context) (int, error)
	// Delete removes a user. FK cascade handles user_roles, sessions, etc.
	Delete(ctx context.Context, id string) error

	// ─── Admin ───

	// ListAdminUsersPaged returns paginated, filtered, sorted users with stats and the
	// total row count under the same WHERE clause.
	// activeVoiceUserIDs overrides last_activity to "now" for currently-in-voice users
	// (DB last_voice_activity only updates at JOIN, so without this overlay the SQL
	// last_activity sort can drop active voice users off page 1 once messaging from
	// other users overtakes their stale stamp).
	// Caller MUST pre-validate params.Limit/Offset (>= 0); Sort/Dir are validated here
	// against an internal whitelist — invalid values fall back to created_at DESC.
	ListAdminUsersPaged(ctx context.Context, params models.AdminListPageParams, defaultQuotaBytes int64, activeVoiceUserIDs []string) (models.AdminUserListPage, error)

	UpdateLastVoiceActivity(ctx context.Context, userID string) error

	// ─── Platform Ban ───

	// PlatformBan blocks login, WS connect, and re-registration with the same email.
	PlatformBan(ctx context.Context, userID, reason, bannedBy string) error
	PlatformUnban(ctx context.Context, userID string) error
	// IsEmailPlatformBanned checks the platform_bans table for a banned email.
	IsEmailPlatformBanned(ctx context.Context, email string) (bool, error)
	// IsUsernamePlatformBanned checks the platform_bans table for a banned username.
	IsUsernamePlatformBanned(ctx context.Context, username string) (bool, error)
	// IsPlatformBannedByUserID checks if a platform_bans record exists for a user ID (works after hard-delete).
	IsPlatformBannedByUserID(ctx context.Context, userID string) (bool, error)
	// InsertPlatformBan adds a persistent ban record that survives user hard-delete.
	InsertPlatformBan(ctx context.Context, email, username, userID, reason, bannedBy string) error
	// DeletePlatformBan removes the persistent ban record for a user.
	DeletePlatformBan(ctx context.Context, userID string) error
	// DeleteAllMessagesByUser removes all messages (server + DM) and attachments for a user.
	DeleteAllMessagesByUser(ctx context.Context, userID string) error
	// HardDeleteUser anonymizes the user (tombstone) — username renamed to deleted_<id>,
	// personal data wiped, password cleared, all relationships removed. Messages preserved
	// via tombstone semantics (user row stays so messages.user_id keeps referential integrity).
	HardDeleteUser(ctx context.Context, userID string, byAdmin bool) error
	// SoftDelete marks the user deleted_at = NOW. Recoverable via login flow.
	SoftDelete(ctx context.Context, userID string, byAdmin bool) error
	// Restore clears soft-delete fields. Caller verifies authorization (e.g., password).
	Restore(ctx context.Context, userID string) error
	// ListSoftDeletedExpired returns soft-deleted users whose deleted_at is older than ttlDays.
	// Used by the cleanup worker to identify users ready for tombstone hard-delete.
	ListSoftDeletedExpired(ctx context.Context, ttlDays int) ([]models.User, error)

	// ─── Download Prompt ───

	SetDownloadPromptSeen(ctx context.Context, userID string) error
	SetWelcomeSeen(ctx context.Context, userID string) error

	// ─── Platform Admin ───

	SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error

	// ─── Admin Badge Watermarks ───

	MarkFeedbackSeen(ctx context.Context, userID string) error
	MarkReportsSeen(ctx context.Context, userID string) error
	// ListPlatformAdminEmails returns the email address of every active
	// platform admin with one set. Returns an empty slice if none.
	ListPlatformAdminEmails(ctx context.Context) ([]string, error)
}
