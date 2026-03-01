// Package main — Repository katmanı başlatma.
//
// initRepositories, tüm repository implementasyonlarını oluşturur.
// Her repository bir SQL.DB bağlantısı alır ve interface döner.
// main.go'daki wire-up'ı modülerleştirmek için bu dosyaya taşındı.
package main

import (
	"database/sql"

	"github.com/akinalp/mqvi/repository"
)

// Repositories, tüm repository instance'larını tutan container struct.
//
// Neden struct? 20 ayrı repository değişkeni yerine tek struct kullanmak:
// 1. Fonksiyon imzalarını temiz tutar (tek parametre yerine 20 parametre)
// 2. Yeni repository eklendiğinde sadece struct + initRepositories güncellenir
// 3. IDE auto-complete ile kolay erişim (repos.User, repos.Channel, vb.)
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
}

// initRepositories, veritabanı bağlantısından tüm repository'leri oluşturur.
//
// Her NewSQLite* fonksiyonu aynı *sql.DB'yi alır — Go'nun sql.DB'si
// thread-safe connection pool'dur, paylaşılması güvenlidir.
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
	}
}
