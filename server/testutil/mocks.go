// Package testutil provides hand-rolled mocks for testing services.
// Each mock stores function fields that tests override per-case.
package testutil

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/ws"
)

// ─── UserRepository mock ───

type MockUserRepo struct {
	CreateFn                  func(ctx context.Context, user *models.User) error
	GetByIDFn                 func(ctx context.Context, id string) (*models.User, error)
	GetByUsernameFn           func(ctx context.Context, username string) (*models.User, error)
	GetAllFn                  func(ctx context.Context) ([]models.User, error)
	UpdateFn                  func(ctx context.Context, user *models.User) error
	UpdateStatusFn            func(ctx context.Context, userID string, status models.UserStatus) error
	UpdatePasswordFn          func(ctx context.Context, userID string, newPasswordHash string) error
	UpdateEmailFn             func(ctx context.Context, userID string, email *string) error
	GetByEmailFn              func(ctx context.Context, email string) (*models.User, error)
	CountFn                   func(ctx context.Context) (int, error)
	DeleteFn                  func(ctx context.Context, id string) error
	ListAllUsersWithStatsFn   func(ctx context.Context) ([]models.AdminUserListItem, error)
	UpdateLastVoiceActivityFn func(ctx context.Context, userID string) error
	PlatformBanFn             func(ctx context.Context, userID, reason, bannedBy string) error
	PlatformUnbanFn           func(ctx context.Context, userID string) error
	IsEmailPlatformBannedFn   func(ctx context.Context, email string) (bool, error)
	DeleteAllMessagesByUserFn func(ctx context.Context, userID string) error
	HardDeleteUserFn          func(ctx context.Context, userID string) error
	SetPlatformAdminFn        func(ctx context.Context, userID string, isAdmin bool) error
}

func (m *MockUserRepo) Create(ctx context.Context, user *models.User) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, user)
	}
	return nil
}
func (m *MockUserRepo) GetByID(ctx context.Context, id string) (*models.User, error) {
	return m.GetByIDFn(ctx, id)
}
func (m *MockUserRepo) GetByUsername(ctx context.Context, username string) (*models.User, error) {
	return m.GetByUsernameFn(ctx, username)
}
func (m *MockUserRepo) GetAll(ctx context.Context) ([]models.User, error) {
	if m.GetAllFn != nil {
		return m.GetAllFn(ctx)
	}
	return nil, nil
}
func (m *MockUserRepo) Update(ctx context.Context, user *models.User) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, user)
	}
	return nil
}
func (m *MockUserRepo) UpdateStatus(ctx context.Context, userID string, status models.UserStatus) error {
	if m.UpdateStatusFn != nil {
		return m.UpdateStatusFn(ctx, userID, status)
	}
	return nil
}
func (m *MockUserRepo) UpdatePassword(ctx context.Context, userID string, newPasswordHash string) error {
	if m.UpdatePasswordFn != nil {
		return m.UpdatePasswordFn(ctx, userID, newPasswordHash)
	}
	return nil
}
func (m *MockUserRepo) UpdateEmail(ctx context.Context, userID string, email *string) error {
	if m.UpdateEmailFn != nil {
		return m.UpdateEmailFn(ctx, userID, email)
	}
	return nil
}
func (m *MockUserRepo) UpdateWallpaper(_ context.Context, _ string, _ *string) error {
	return nil
}
func (m *MockUserRepo) GetByEmail(ctx context.Context, email string) (*models.User, error) {
	if m.GetByEmailFn != nil {
		return m.GetByEmailFn(ctx, email)
	}
	return nil, nil
}
func (m *MockUserRepo) Count(ctx context.Context) (int, error) {
	if m.CountFn != nil {
		return m.CountFn(ctx)
	}
	return 0, nil
}
func (m *MockUserRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockUserRepo) ListAllUsersWithStats(ctx context.Context) ([]models.AdminUserListItem, error) {
	if m.ListAllUsersWithStatsFn != nil {
		return m.ListAllUsersWithStatsFn(ctx)
	}
	return nil, nil
}
func (m *MockUserRepo) UpdateLastVoiceActivity(ctx context.Context, userID string) error {
	if m.UpdateLastVoiceActivityFn != nil {
		return m.UpdateLastVoiceActivityFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) PlatformBan(ctx context.Context, userID, reason, bannedBy string) error {
	if m.PlatformBanFn != nil {
		return m.PlatformBanFn(ctx, userID, reason, bannedBy)
	}
	return nil
}
func (m *MockUserRepo) PlatformUnban(ctx context.Context, userID string) error {
	if m.PlatformUnbanFn != nil {
		return m.PlatformUnbanFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	if m.IsEmailPlatformBannedFn != nil {
		return m.IsEmailPlatformBannedFn(ctx, email)
	}
	return false, nil
}
func (m *MockUserRepo) DeleteAllMessagesByUser(ctx context.Context, userID string) error {
	if m.DeleteAllMessagesByUserFn != nil {
		return m.DeleteAllMessagesByUserFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) HardDeleteUser(ctx context.Context, userID string) error {
	if m.HardDeleteUserFn != nil {
		return m.HardDeleteUserFn(ctx, userID)
	}
	return nil
}
func (m *MockUserRepo) SetPlatformAdmin(ctx context.Context, userID string, isAdmin bool) error {
	if m.SetPlatformAdminFn != nil {
		return m.SetPlatformAdminFn(ctx, userID, isAdmin)
	}
	return nil
}
func (m *MockUserRepo) UpdatePrefStatus(_ context.Context, _ string, _ models.UserStatus) error {
	return nil
}
func (m *MockUserRepo) SetDownloadPromptSeen(_ context.Context, _ string) error {
	return nil
}
func (m *MockUserRepo) SetWelcomeSeen(_ context.Context, _ string) error {
	return nil
}

// ─── SessionRepository mock ───

type MockSessionRepo struct {
	CreateFn            func(ctx context.Context, session *models.Session) error
	GetByRefreshTokenFn func(ctx context.Context, token string) (*models.Session, error)
	DeleteByIDFn        func(ctx context.Context, id string) error
	DeleteByUserIDFn    func(ctx context.Context, userID string) error
	DeleteExpiredFn     func(ctx context.Context) error
}

func (m *MockSessionRepo) Create(ctx context.Context, session *models.Session) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, session)
	}
	return nil
}
func (m *MockSessionRepo) GetByRefreshToken(ctx context.Context, token string) (*models.Session, error) {
	return m.GetByRefreshTokenFn(ctx, token)
}
func (m *MockSessionRepo) DeleteByID(ctx context.Context, id string) error {
	if m.DeleteByIDFn != nil {
		return m.DeleteByIDFn(ctx, id)
	}
	return nil
}
func (m *MockSessionRepo) DeleteByUserID(ctx context.Context, userID string) error {
	if m.DeleteByUserIDFn != nil {
		return m.DeleteByUserIDFn(ctx, userID)
	}
	return nil
}
func (m *MockSessionRepo) DeleteExpired(ctx context.Context) error {
	if m.DeleteExpiredFn != nil {
		return m.DeleteExpiredFn(ctx)
	}
	return nil
}

// ─── PasswordResetRepository mock ───

type MockResetRepo struct {
	CreateFn            func(ctx context.Context, token *models.PasswordResetToken) error
	GetByTokenHashFn    func(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error)
	DeleteByIDFn        func(ctx context.Context, id string) error
	DeleteByUserIDFn    func(ctx context.Context, userID string) error
	DeleteExpiredFn     func(ctx context.Context) error
	GetLatestByUserIDFn func(ctx context.Context, userID string) (*models.PasswordResetToken, error)
}

func (m *MockResetRepo) Create(ctx context.Context, token *models.PasswordResetToken) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, token)
	}
	return nil
}
func (m *MockResetRepo) GetByTokenHash(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error) {
	if m.GetByTokenHashFn != nil {
		return m.GetByTokenHashFn(ctx, tokenHash)
	}
	return nil, nil
}
func (m *MockResetRepo) DeleteByID(ctx context.Context, id string) error {
	if m.DeleteByIDFn != nil {
		return m.DeleteByIDFn(ctx, id)
	}
	return nil
}
func (m *MockResetRepo) DeleteByUserID(ctx context.Context, userID string) error {
	if m.DeleteByUserIDFn != nil {
		return m.DeleteByUserIDFn(ctx, userID)
	}
	return nil
}
func (m *MockResetRepo) DeleteExpired(ctx context.Context) error {
	if m.DeleteExpiredFn != nil {
		return m.DeleteExpiredFn(ctx)
	}
	return nil
}
func (m *MockResetRepo) GetLatestByUserID(ctx context.Context, userID string) (*models.PasswordResetToken, error) {
	if m.GetLatestByUserIDFn != nil {
		return m.GetLatestByUserIDFn(ctx, userID)
	}
	return nil, nil
}

// ─── RoleRepository mock ───

type MockRoleRepo struct {
	GetByIDFn              func(ctx context.Context, id string) (*models.Role, error)
	GetAllByServerFn       func(ctx context.Context, serverID string) ([]models.Role, error)
	GetDefaultByServerFn   func(ctx context.Context, serverID string) (*models.Role, error)
	GetByUserIDAndServerFn func(ctx context.Context, userID, serverID string) ([]models.Role, error)
	GetMaxPositionFn       func(ctx context.Context, serverID string) (int, error)
	CreateFn               func(ctx context.Context, role *models.Role) error
	UpdateFn               func(ctx context.Context, role *models.Role) error
	DeleteFn               func(ctx context.Context, id string) error
	UpdatePositionsFn      func(ctx context.Context, items []models.PositionUpdate) error
	AssignToUserFn         func(ctx context.Context, userID, roleID, serverID string) error
	RemoveFromUserFn       func(ctx context.Context, userID, roleID string) error
}

func (m *MockRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	if m.GetAllByServerFn != nil {
		return m.GetAllByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetDefaultByServer(ctx context.Context, serverID string) (*models.Role, error) {
	if m.GetDefaultByServerFn != nil {
		return m.GetDefaultByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	if m.GetByUserIDAndServerFn != nil {
		return m.GetByUserIDAndServerFn(ctx, userID, serverID)
	}
	return nil, nil
}
func (m *MockRoleRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	if m.GetMaxPositionFn != nil {
		return m.GetMaxPositionFn(ctx, serverID)
	}
	return 0, nil
}
func (m *MockRoleRepo) Create(ctx context.Context, role *models.Role) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, role)
	}
	return nil
}
func (m *MockRoleRepo) Update(ctx context.Context, role *models.Role) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, role)
	}
	return nil
}
func (m *MockRoleRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockRoleRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	if m.UpdatePositionsFn != nil {
		return m.UpdatePositionsFn(ctx, items)
	}
	return nil
}
func (m *MockRoleRepo) AssignToUser(ctx context.Context, userID, roleID, serverID string) error {
	if m.AssignToUserFn != nil {
		return m.AssignToUserFn(ctx, userID, roleID, serverID)
	}
	return nil
}
func (m *MockRoleRepo) RemoveFromUser(ctx context.Context, userID, roleID string) error {
	if m.RemoveFromUserFn != nil {
		return m.RemoveFromUserFn(ctx, userID, roleID)
	}
	return nil
}

// ─── ChannelPermissionRepository mock ───

type MockChannelPermRepo struct {
	GetByChannelFn         func(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error)
	GetByChannelAndRolesFn func(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error)
	GetByRolesFn           func(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error)
	SetFn                  func(ctx context.Context, override *models.ChannelPermissionOverride) error
	DeleteFn               func(ctx context.Context, channelID, roleID string) error
	DeleteAllByChannelFn   func(ctx context.Context, channelID string) error
}

func (m *MockChannelPermRepo) GetByChannel(ctx context.Context, channelID string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByChannelFn != nil {
		return m.GetByChannelFn(ctx, channelID)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) GetByChannelAndRoles(ctx context.Context, channelID string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByChannelAndRolesFn != nil {
		return m.GetByChannelAndRolesFn(ctx, channelID, roleIDs)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) GetByRoles(ctx context.Context, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
	if m.GetByRolesFn != nil {
		return m.GetByRolesFn(ctx, roleIDs)
	}
	return nil, nil
}
func (m *MockChannelPermRepo) Set(ctx context.Context, override *models.ChannelPermissionOverride) error {
	if m.SetFn != nil {
		return m.SetFn(ctx, override)
	}
	return nil
}
func (m *MockChannelPermRepo) Delete(ctx context.Context, channelID, roleID string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, channelID, roleID)
	}
	return nil
}
func (m *MockChannelPermRepo) DeleteAllByChannel(ctx context.Context, channelID string) error {
	if m.DeleteAllByChannelFn != nil {
		return m.DeleteAllByChannelFn(ctx, channelID)
	}
	return nil
}

// ─── ChannelRepository mock (ChannelGetter) ───

type MockChannelRepo struct {
	GetByIDFn         func(ctx context.Context, id string) (*models.Channel, error)
	GetAllByServerFn  func(ctx context.Context, serverID string) ([]models.Channel, error)
	GetByCategoryIDFn func(ctx context.Context, categoryID string) ([]models.Channel, error)
	CreateFn          func(ctx context.Context, channel *models.Channel) error
	UpdateFn          func(ctx context.Context, channel *models.Channel) error
	DeleteFn          func(ctx context.Context, id string) error
	GetMaxPositionFn  func(ctx context.Context, categoryID string) (int, error)
	UpdatePositionsFn func(ctx context.Context, items []models.PositionUpdate) error
}

func (m *MockChannelRepo) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockChannelRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error) {
	if m.GetAllByServerFn != nil {
		return m.GetAllByServerFn(ctx, serverID)
	}
	return nil, nil
}
func (m *MockChannelRepo) GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error) {
	if m.GetByCategoryIDFn != nil {
		return m.GetByCategoryIDFn(ctx, categoryID)
	}
	return nil, nil
}
func (m *MockChannelRepo) Create(ctx context.Context, channel *models.Channel) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, channel)
	}
	return nil
}
func (m *MockChannelRepo) Update(ctx context.Context, channel *models.Channel) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, channel)
	}
	return nil
}
func (m *MockChannelRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}
func (m *MockChannelRepo) GetMaxPosition(ctx context.Context, categoryID string) (int, error) {
	if m.GetMaxPositionFn != nil {
		return m.GetMaxPositionFn(ctx, categoryID)
	}
	return 0, nil
}
func (m *MockChannelRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	if m.UpdatePositionsFn != nil {
		return m.UpdatePositionsFn(ctx, items)
	}
	return nil
}

// ─── MessageRepository mock ───

type MockMessageRepo struct {
	CreateFn         func(ctx context.Context, message *models.Message) error
	GetByIDFn        func(ctx context.Context, id string) (*models.Message, error)
	GetByChannelIDFn func(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	UpdateFn         func(ctx context.Context, message *models.Message) error
	DeleteFn         func(ctx context.Context, id string) error
}

func (m *MockMessageRepo) Create(ctx context.Context, message *models.Message) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, message)
	}
	return nil
}
func (m *MockMessageRepo) GetByID(ctx context.Context, id string) (*models.Message, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockMessageRepo) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error) {
	if m.GetByChannelIDFn != nil {
		return m.GetByChannelIDFn(ctx, channelID, beforeID, limit)
	}
	return nil, nil
}
func (m *MockMessageRepo) Update(ctx context.Context, message *models.Message) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, message)
	}
	return nil
}
func (m *MockMessageRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}

// ─── WS mock (Broadcaster, EventPublisher) ───

type MockBroadcaster struct {
	BroadcastToAllFn          func(event ws.Event)
	BroadcastToAllExceptFn    func(excludeUserID string, event ws.Event)
	BroadcastToUserFn         func(userID string, event ws.Event)
	BroadcastToUsersFn        func(userIDs []string, event ws.Event)
	BroadcastToServerFn       func(serverID string, event ws.Event)
	BroadcastToServerExceptFn func(serverID, excludeUserID string, event ws.Event)
}

func (m *MockBroadcaster) BroadcastToAll(event ws.Event) {
	if m.BroadcastToAllFn != nil {
		m.BroadcastToAllFn(event)
	}
}
func (m *MockBroadcaster) BroadcastToAllExcept(excludeUserID string, event ws.Event) {
	if m.BroadcastToAllExceptFn != nil {
		m.BroadcastToAllExceptFn(excludeUserID, event)
	}
}
func (m *MockBroadcaster) BroadcastToUser(userID string, event ws.Event) {
	if m.BroadcastToUserFn != nil {
		m.BroadcastToUserFn(userID, event)
	}
}
func (m *MockBroadcaster) BroadcastToUsers(userIDs []string, event ws.Event) {
	if m.BroadcastToUsersFn != nil {
		m.BroadcastToUsersFn(userIDs, event)
	}
}
func (m *MockBroadcaster) BroadcastToServer(serverID string, event ws.Event) {
	if m.BroadcastToServerFn != nil {
		m.BroadcastToServerFn(serverID, event)
	}
}
func (m *MockBroadcaster) BroadcastToServerExcept(serverID, excludeUserID string, event ws.Event) {
	if m.BroadcastToServerExceptFn != nil {
		m.BroadcastToServerExceptFn(serverID, excludeUserID, event)
	}
}

// MockEventPublisher satisfies ws.EventPublisher (Broadcaster + UserStateProvider + ClientManager).
type MockEventPublisher struct {
	MockBroadcaster
	GetOnlineUserIDsFn          func() []string
	GetVisibleOnlineUserIDsFn   func() []string
	GetOnlineUserIDsForServerFn func(serverID string) []string
	SetInvisibleFn              func(userID string, invisible bool)
	DisconnectUserFn            func(userID string)
	AddClientServerIDFn         func(userID, serverID string)
	RemoveClientServerIDFn      func(userID, serverID string)
}

func (m *MockEventPublisher) GetOnlineUserIDs() []string {
	if m.GetOnlineUserIDsFn != nil {
		return m.GetOnlineUserIDsFn()
	}
	return nil
}
func (m *MockEventPublisher) GetVisibleOnlineUserIDs() []string {
	if m.GetVisibleOnlineUserIDsFn != nil {
		return m.GetVisibleOnlineUserIDsFn()
	}
	return nil
}
func (m *MockEventPublisher) GetOnlineUserIDsForServer(serverID string) []string {
	if m.GetOnlineUserIDsForServerFn != nil {
		return m.GetOnlineUserIDsForServerFn(serverID)
	}
	return nil
}
func (m *MockEventPublisher) SetInvisible(userID string, invisible bool) {
	if m.SetInvisibleFn != nil {
		m.SetInvisibleFn(userID, invisible)
	}
}
func (m *MockEventPublisher) DisconnectUser(userID string) {
	if m.DisconnectUserFn != nil {
		m.DisconnectUserFn(userID)
	}
}
func (m *MockEventPublisher) AddClientServerID(userID, serverID string) {
	if m.AddClientServerIDFn != nil {
		m.AddClientServerIDFn(userID, serverID)
	}
}
func (m *MockEventPublisher) RemoveClientServerID(userID, serverID string) {
	if m.RemoveClientServerIDFn != nil {
		m.RemoveClientServerIDFn(userID, serverID)
	}
}

// ─── EmailSender mock ───

type MockEmailSender struct {
	SendPasswordResetFn             func(ctx context.Context, toEmail, token string) error
	SendPlatformBanNotificationFn   func(ctx context.Context, toEmail, reason string) error
	SendAccountDeleteNotificationFn func(ctx context.Context, toEmail, reason string) error
	SendServerDeleteNotificationFn  func(ctx context.Context, toEmail, serverName, reason string) error
}

func (m *MockEmailSender) SendPasswordReset(ctx context.Context, toEmail, token string) error {
	if m.SendPasswordResetFn != nil {
		return m.SendPasswordResetFn(ctx, toEmail, token)
	}
	return nil
}
func (m *MockEmailSender) SendPlatformBanNotification(ctx context.Context, toEmail, reason string) error {
	if m.SendPlatformBanNotificationFn != nil {
		return m.SendPlatformBanNotificationFn(ctx, toEmail, reason)
	}
	return nil
}
func (m *MockEmailSender) SendAccountDeleteNotification(ctx context.Context, toEmail, reason string) error {
	if m.SendAccountDeleteNotificationFn != nil {
		return m.SendAccountDeleteNotificationFn(ctx, toEmail, reason)
	}
	return nil
}
func (m *MockEmailSender) SendServerDeleteNotification(ctx context.Context, toEmail, serverName, reason string) error {
	if m.SendServerDeleteNotificationFn != nil {
		return m.SendServerDeleteNotificationFn(ctx, toEmail, serverName, reason)
	}
	return nil
}

// ─── MockBroadcastAndOnline satisfies ws.BroadcastAndOnline ───

type MockBroadcastAndOnline struct {
	MockBroadcaster
	GetOnlineUserIDsFn          func() []string
	GetVisibleOnlineUserIDsFn   func() []string
	GetOnlineUserIDsForServerFn func(serverID string) []string
}

func (m *MockBroadcastAndOnline) GetOnlineUserIDs() []string {
	if m.GetOnlineUserIDsFn != nil {
		return m.GetOnlineUserIDsFn()
	}
	return nil
}
func (m *MockBroadcastAndOnline) GetVisibleOnlineUserIDs() []string {
	if m.GetVisibleOnlineUserIDsFn != nil {
		return m.GetVisibleOnlineUserIDsFn()
	}
	return nil
}
func (m *MockBroadcastAndOnline) GetOnlineUserIDsForServer(serverID string) []string {
	if m.GetOnlineUserIDsForServerFn != nil {
		return m.GetOnlineUserIDsForServerFn(serverID)
	}
	return nil
}

// ─── AttachmentRepository mock ───

type MockAttachmentRepo struct {
	CreateFn          func(ctx context.Context, attachment *models.Attachment) error
	GetByMessageIDFn  func(ctx context.Context, messageID string) ([]models.Attachment, error)
	GetByMessageIDsFn func(ctx context.Context, messageIDs []string) ([]models.Attachment, error)
	DeleteFn          func(ctx context.Context, id string) error
}

func (m *MockAttachmentRepo) Create(ctx context.Context, attachment *models.Attachment) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, attachment)
	}
	return nil
}
func (m *MockAttachmentRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error) {
	if m.GetByMessageIDFn != nil {
		return m.GetByMessageIDFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockAttachmentRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}
func (m *MockAttachmentRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}

// ─── MentionRepository mock ───

type MockMentionRepo struct {
	SaveMentionsFn        func(ctx context.Context, messageID string, userIDs []string) error
	DeleteByMessageIDFn   func(ctx context.Context, messageID string) error
	GetMentionedUserIDsFn func(ctx context.Context, messageID string) ([]string, error)
	GetByMessageIDsFn     func(ctx context.Context, messageIDs []string) (map[string][]string, error)
}

func (m *MockMentionRepo) SaveMentions(ctx context.Context, messageID string, userIDs []string) error {
	if m.SaveMentionsFn != nil {
		return m.SaveMentionsFn(ctx, messageID, userIDs)
	}
	return nil
}
func (m *MockMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if m.DeleteByMessageIDFn != nil {
		return m.DeleteByMessageIDFn(ctx, messageID)
	}
	return nil
}
func (m *MockMentionRepo) GetMentionedUserIDs(ctx context.Context, messageID string) ([]string, error) {
	if m.GetMentionedUserIDsFn != nil {
		return m.GetMentionedUserIDsFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}

// ─── RoleMentionRepository mock ───

type MockRoleMentionRepo struct {
	SaveRoleMentionsFn  func(ctx context.Context, messageID string, roleIDs []string) error
	DeleteByMessageIDFn func(ctx context.Context, messageID string) error
	GetByMessageIDsFn   func(ctx context.Context, messageIDs []string) (map[string][]string, error)
}

func (m *MockRoleMentionRepo) SaveRoleMentions(ctx context.Context, messageID string, roleIDs []string) error {
	if m.SaveRoleMentionsFn != nil {
		return m.SaveRoleMentionsFn(ctx, messageID, roleIDs)
	}
	return nil
}
func (m *MockRoleMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if m.DeleteByMessageIDFn != nil {
		return m.DeleteByMessageIDFn(ctx, messageID)
	}
	return nil
}
func (m *MockRoleMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}

// ─── ReactionRepository mock ───

type MockReactionRepo struct {
	ToggleFn          func(ctx context.Context, messageID, userID, emoji string) (bool, error)
	GetByMessageIDFn  func(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetByMessageIDsFn func(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)
}

func (m *MockReactionRepo) Toggle(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	if m.ToggleFn != nil {
		return m.ToggleFn(ctx, messageID, userID, emoji)
	}
	return false, nil
}
func (m *MockReactionRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error) {
	if m.GetByMessageIDFn != nil {
		return m.GetByMessageIDFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockReactionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}

// ─── ChannelPermResolver mock ───

type MockChannelPermResolver struct {
	ResolveChannelPermissionsFn func(ctx context.Context, userID, channelID string) (models.Permission, error)
}

func (m *MockChannelPermResolver) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	if m.ResolveChannelPermissionsFn != nil {
		return m.ResolveChannelPermissionsFn(ctx, userID, channelID)
	}
	return 0, nil
}

// ─── ReadStateRepository mock ───

type MockReadStateRepo struct {
	UpsertFn                   func(ctx context.Context, userID, channelID, messageID string) error
	GetUnreadCountsFn          func(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error)
	MarkAllReadFn              func(ctx context.Context, userID, serverID string) error
	IncrementUnreadCountsFn    func(ctx context.Context, channelID, excludeUserID string) error
	DecrementUnreadForDeletedFn func(ctx context.Context, channelID, authorID string, deletedAt time.Time) error
}

func (m *MockReadStateRepo) Upsert(ctx context.Context, userID, channelID, messageID string) error {
	if m.UpsertFn != nil {
		return m.UpsertFn(ctx, userID, channelID, messageID)
	}
	return nil
}
func (m *MockReadStateRepo) GetUnreadCounts(ctx context.Context, userID, serverID string) ([]models.UnreadInfo, error) {
	if m.GetUnreadCountsFn != nil {
		return m.GetUnreadCountsFn(ctx, userID, serverID)
	}
	return nil, nil
}
func (m *MockReadStateRepo) MarkAllRead(ctx context.Context, userID, serverID string) error {
	if m.MarkAllReadFn != nil {
		return m.MarkAllReadFn(ctx, userID, serverID)
	}
	return nil
}
func (m *MockReadStateRepo) IncrementUnreadCounts(ctx context.Context, channelID, excludeUserID string) error {
	if m.IncrementUnreadCountsFn != nil {
		return m.IncrementUnreadCountsFn(ctx, channelID, excludeUserID)
	}
	return nil
}
func (m *MockReadStateRepo) DecrementUnreadForDeleted(ctx context.Context, channelID, authorID string, deletedAt time.Time) error {
	if m.DecrementUnreadForDeletedFn != nil {
		return m.DecrementUnreadForDeletedFn(ctx, channelID, authorID, deletedAt)
	}
	return nil
}

// ─── FileURLSigner mock (no-op, returns URLs unchanged) ───

type MockFileURLSigner struct{}

func (m *MockFileURLSigner) SignURL(fileURL string) string    { return fileURL }
func (m *MockFileURLSigner) SignURLPtr(p *string) *string     { return p }
