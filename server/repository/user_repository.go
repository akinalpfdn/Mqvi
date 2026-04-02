package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// UserRepository defines data access for users.
type UserRepository interface {
	Create(ctx context.Context, user *models.User) error
	GetByID(ctx context.Context, id string) (*models.User, error)
	GetByUsername(ctx context.Context, username string) (*models.User, error)
	GetAll(ctx context.Context) ([]models.User, error)
	Update(ctx context.Context, user *models.User) error
	UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error
	UpdatePrefStatus(ctx context.Context, userID string, prefStatus models.UserStatus) error
	UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error
	// UpdateEmail sets or clears the user's email. nil removes, *string sets.
	UpdateEmail(ctx context.Context, userID string, email *string) error
	GetByEmail(ctx context.Context, email string) (*models.User, error)
	Count(ctx context.Context) (int, error)
	// Delete removes a user. FK cascade handles user_roles, sessions, etc.
	Delete(ctx context.Context, id string) error

	// ─── Admin ───

	// ListAllUsersWithStats returns all users with aggregated stats (message count, storage, bans, etc.).
	ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error)

	UpdateLastVoiceActivity(ctx context.Context, userID string) error

	// ─── Platform Ban ───

	// PlatformBan blocks login, WS connect, and re-registration with the same email.
	PlatformBan(ctx context.Context, userID, reason, bannedBy string) error
	PlatformUnban(ctx context.Context, userID string) error
	// IsEmailPlatformBanned checks if an email belongs to a platform-banned user.
	IsEmailPlatformBanned(ctx context.Context, email string) (bool, error)
	// DeleteAllMessagesByUser removes all messages (server + DM) and attachments for a user.
	DeleteAllMessagesByUser(ctx context.Context, userID string) error
	// HardDeleteUser permanently deletes a user and all cascaded data.
	// Owned servers must be cleaned up beforehand (no CASCADE on servers.owner_id).
	HardDeleteUser(ctx context.Context, userID string) error

	// ─── Download Prompt ───

	SetDownloadPromptSeen(ctx context.Context, userID string) error
	SetWelcomeSeen(ctx context.Context, userID string) error

	// ─── Platform Admin ───

	SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error
}
