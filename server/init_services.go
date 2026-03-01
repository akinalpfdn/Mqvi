// Package main — Service katmanı başlatma.
//
// initServices, tüm service implementasyonlarını oluşturur.
// Her service, ihtiyaç duyduğu repository interface'lerini ve diğer
// dependency'leri constructor injection ile alır.
//
// ÖNEMLİ sıralama kuralları (circular dependency ve closure scoping):
// 1. channelPermService → voiceService ve messageService'den ÖNCE
// 2. voiceService → Hub callback'lerinden ÖNCE
// 3. p2pCallService → Hub callback'lerinden ÖNCE
package main

import (
	"database/sql"
	"log"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// Services, tüm service instance'larını tutan container struct.
type Services struct {
	Auth              services.AuthService
	Server            services.ServerService
	Channel           services.ChannelService
	Category          services.CategoryService
	Message           services.MessageService
	Upload            services.UploadService
	DMUpload          services.DMUploadService
	Member            services.MemberService
	Role              services.RoleService
	Voice             services.VoiceService
	Invite            services.InviteService
	Pin               services.PinService
	Search            services.SearchService
	ReadState         services.ReadStateService
	DM                services.DMService
	Reaction          services.ReactionService
	ChannelPermission services.ChannelPermissionService
	Friendship        services.FriendshipService
	LiveKitAdmin      services.LiveKitAdminService
	P2PCall           services.P2PCallService
	MetricsHistory    services.MetricsHistoryService
}

// RateLimiters, tüm rate limiter instance'larını tutan container.
type RateLimiters struct {
	Login   *ratelimit.LoginRateLimiter
	Message *ratelimit.MessageRateLimiter
}

// initServices, tüm service'leri ve rate limiter'ları oluşturur.
//
// Sıralama kritiktir — bkz. dosya başı yorum.
// hub ve encryptionKey service'ler arası paylaşılan dependency'lerdir.
func initServices(db *sql.DB, repos *Repositories, hub ws.EventPublisher, cfg *config.Config, encryptionKey []byte) (*Services, *RateLimiters, services.MetricsCollector) {
	// ─── Sıralama-kritik service'ler ───

	// ChannelPermissionService — VoiceService ve MessageService'den ÖNCE
	channelPermService := services.NewChannelPermissionService(
		repos.ChannelPermission, repos.Role, repos.Channel, hub,
	)

	// VoiceService — Hub callback'lerinden ÖNCE (closure scoping)
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, encryptionKey,
	)

	// P2PCallService — Hub callback'lerinden ÖNCE
	p2pCallService := services.NewP2PCallService(repos.Friendship, repos.User, hub)

	// ─── Email service (opsiyonel) ───
	var emailSender email.EmailSender
	if cfg.Email.ResendAPIKey != "" && cfg.Email.FromEmail != "" && cfg.Email.AppURL != "" {
		emailSender = email.NewResendSender(cfg.Email.ResendAPIKey, cfg.Email.FromEmail, cfg.Email.AppURL)
		log.Printf("[main] email service enabled (from=%s)", cfg.Email.FromEmail)
	} else {
		log.Println("[main] email service disabled (RESEND_API_KEY, RESEND_FROM or APP_URL not set)")
	}

	// ─── Diğer service'ler (sıralama bağımsız) ───
	inviteService := services.NewInviteService(repos.Invite, repos.Server)

	authService := services.NewAuthService(
		repos.User, repos.Session, repos.ResetToken, hub, emailSender,
		cfg.JWT.Secret, cfg.JWT.AccessTokenExpiry, cfg.JWT.RefreshTokenExpiry,
	)

	channelService := services.NewChannelService(repos.Channel, repos.Category, hub, channelPermService)
	categoryService := services.NewCategoryService(repos.Category, hub)
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.Reaction, hub, channelPermService,
	)
	uploadService := services.NewUploadService(repos.Attachment, cfg.Upload.Dir, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(repos.User, repos.Role, repos.Ban, repos.Server, hub, voiceService)
	roleService := services.NewRoleService(repos.Role, repos.User, hub)
	serverService := services.NewServerService(
		db, repos.Server, repos.LiveKit, repos.Role, repos.Channel,
		repos.Category, repos.User, inviteService, hub, encryptionKey,
	)
	livekitAdminService := services.NewLiveKitAdminService(
		repos.LiveKit, repos.Server, repos.User, repos.Channel,
		voiceService, encryptionKey,
	)
	pinService := services.NewPinService(repos.Pin, repos.Message, hub)
	searchService := services.NewSearchService(repos.Search)
	readStateService := services.NewReadStateService(repos.ReadState, channelPermService)
	dmService := services.NewDMService(repos.DM, repos.User, hub)
	dmUploadService := services.NewDMUploadService(repos.DM, cfg.Upload.Dir, cfg.Upload.MaxSize)
	reactionService := services.NewReactionService(repos.Reaction, repos.Message, hub)
	friendshipService := services.NewFriendshipService(repos.Friendship, repos.User, hub)

	// ─── Metrics History ───
	metricsHistoryService := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	metricsCollector := services.NewMetricsCollector(
		repos.LiveKit, repos.MetricsHistory,
		5*time.Minute, // collection interval
		30,            // retention days
	)

	// ─── Rate Limiters ───
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)
	messageLimiter := ratelimit.NewMessageRateLimiter(5, 5*time.Second, 15*time.Second)

	svcs := &Services{
		Auth:              authService,
		Server:            serverService,
		Channel:           channelService,
		Category:          categoryService,
		Message:           messageService,
		Upload:            uploadService,
		DMUpload:          dmUploadService,
		Member:            memberService,
		Role:              roleService,
		Voice:             voiceService,
		Invite:            inviteService,
		Pin:               pinService,
		Search:            searchService,
		ReadState:         readStateService,
		DM:                dmService,
		Reaction:          reactionService,
		ChannelPermission: channelPermService,
		Friendship:        friendshipService,
		LiveKitAdmin:      livekitAdminService,
		P2PCall:           p2pCallService,
		MetricsHistory:    metricsHistoryService,
	}

	limiters := &RateLimiters{
		Login:   loginLimiter,
		Message: messageLimiter,
	}

	return svcs, limiters, metricsCollector
}
