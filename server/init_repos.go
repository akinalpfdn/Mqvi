package main

import (
	"database/sql"

	"github.com/akinalp/mqvi/repository"
)

// Repositories holds all repository instances.
type Repositories struct {
	User              repository.UserRepository
	Session           repository.SessionRepository
	Role              repository.RoleRepository
	Channel           repository.ChannelRepository
	Category          repository.CategoryRepository
	Message           repository.MessageRepository
	Attachment        repository.AttachmentRepository
	Ban               repository.BanRepository
	Server            repository.ServerRepository
	Invite            repository.InviteRepository
	Pin               repository.PinRepository
	Search            repository.SearchRepository
	ReadState         repository.ReadStateRepository
	Mention           repository.MentionRepository
	DM                repository.DMRepository
	Reaction          repository.ReactionRepository
	ChannelPermission repository.ChannelPermissionRepository
	Friendship        repository.FriendshipRepository
	LiveKit           repository.LiveKitRepository
	ResetToken        repository.PasswordResetRepository
	MetricsHistory    repository.MetricsHistoryRepository
	ServerMute        repository.ServerMuteRepository
	ChannelMute       repository.ChannelMuteRepository
	DMSettings        repository.DMSettingsRepository
	Report            repository.ReportRepository
	Device            repository.DeviceRepository
	E2EEBackup        repository.E2EEKeyBackupRepository
	GroupSession      repository.GroupSessionRepository
	LinkPreview       repository.LinkPreviewRepository
	Badge             repository.BadgeRepository
	Preferences       repository.PreferencesRepository
}

// initRepositories creates all repositories from the shared DB connection pool.
func initRepositories(conn *sql.DB) *Repositories {
	return &Repositories{
		User:              repository.NewSQLiteUserRepo(conn),
		Session:           repository.NewSQLiteSessionRepo(conn),
		Role:              repository.NewSQLiteRoleRepo(conn),
		Channel:           repository.NewSQLiteChannelRepo(conn),
		Category:          repository.NewSQLiteCategoryRepo(conn),
		Message:           repository.NewSQLiteMessageRepo(conn),
		Attachment:        repository.NewSQLiteAttachmentRepo(conn),
		Ban:               repository.NewSQLiteBanRepo(conn),
		Server:            repository.NewSQLiteServerRepo(conn),
		Invite:            repository.NewSQLiteInviteRepo(conn),
		Pin:               repository.NewSQLitePinRepo(conn),
		Search:            repository.NewSQLiteSearchRepo(conn),
		ReadState:         repository.NewSQLiteReadStateRepo(conn),
		Mention:           repository.NewSQLiteMentionRepo(conn),
		DM:                repository.NewSQLiteDMRepo(conn),
		Reaction:          repository.NewSQLiteReactionRepo(conn),
		ChannelPermission: repository.NewSQLiteChannelPermRepo(conn),
		Friendship:        repository.NewSQLiteFriendshipRepo(conn),
		LiveKit:           repository.NewSQLiteLiveKitRepo(conn),
		ResetToken:        repository.NewSQLiteResetTokenRepo(conn),
		MetricsHistory:    repository.NewSQLiteMetricsHistoryRepo(conn),
		ServerMute:        repository.NewSQLiteServerMuteRepo(conn),
		ChannelMute:       repository.NewSQLiteChannelMuteRepo(conn),
		DMSettings:        repository.NewSQLiteDMSettingsRepo(conn),
		Report:            repository.NewSQLiteReportRepo(conn),
		Device:            repository.NewSQLiteDeviceRepo(conn),
		E2EEBackup:        repository.NewSQLiteE2EEBackupRepo(conn),
		GroupSession:      repository.NewSQLiteGroupSessionRepo(conn),
		LinkPreview:       repository.NewSQLiteLinkPreviewRepo(conn),
		Badge:             repository.NewSQLiteBadgeRepo(conn),
		Preferences:       repository.NewSQLitePreferencesRepo(conn),
	}
}
