package main

import (
	"database/sql"
	"log"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// Services holds all service instances.
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
	ServerMute        services.ServerMuteService
	ChannelMute       services.ChannelMuteService
	DMSettings        services.DMSettingsService
	Block             services.BlockService
	Report            services.ReportService
	ReportUpload      services.ReportUploadService
	AdminUser         services.AdminUserService
	AdminServer       services.AdminServerService
	Device            services.DeviceService
	E2EE              services.E2EEService
	LinkPreview       services.LinkPreviewService
	Badge             services.BadgeService
	Preferences       services.PreferencesService
	AppLog            services.AppLogService
	Feedback          services.FeedbackService
	FeedbackUpload    services.FeedbackUploadService
	Soundboard        services.SoundboardService
}

type RateLimiters struct {
	Login         *ratelimit.LoginRateLimiter
	Message       *ratelimit.MessageRateLimiter
	Register      *ratelimit.LoginRateLimiter
	ForgotPwd     *ratelimit.LoginRateLimiter
	ResetPwd      *ratelimit.LoginRateLimiter
	Feedback      *ratelimit.MessageRateLimiter
}

// initServices creates all services. Order matters:
// channelPermService -> voiceService/messageService (dependency)
// voiceService/p2pCallService -> before Hub callbacks (closure scoping)
func initServices(db *sql.DB, repos *Repositories, hub ws.EventPublisher, cfg *config.Config, encryptionKey []byte, urlSigner services.FileURLSigner) (*Services, *RateLimiters, services.MetricsCollector) {
	// File locator: single source of truth for upload paths and URLs.
	fileLocator := files.NewLocator(cfg.Upload.Dir, cfg.Upload.PublicURL)

	// Order-sensitive services
	channelPermService := services.NewChannelPermissionService(
		repos.ChannelPermission, repos.Role, repos.Channel, hub,
	)
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, hub, repos.Server, encryptionKey, urlSigner,
	)
	p2pCallService := services.NewP2PCallService(repos.Friendship, repos.User, hub, urlSigner)

	// Email service (optional)
	var emailSender email.EmailSender
	if cfg.Email.ResendAPIKey != "" && cfg.Email.FromEmail != "" && cfg.Email.AppURL != "" {
		emailSender = email.NewResendSender(cfg.Email.ResendAPIKey, cfg.Email.FromEmail, cfg.Email.AppURL)
		log.Printf("[main] email service enabled (from=%s)", cfg.Email.FromEmail)
	} else {
		log.Println("[main] email service disabled (RESEND_API_KEY, RESEND_FROM or APP_URL not set)")
	}

	// Remaining services (order-independent)
	inviteService := services.NewInviteService(repos.Invite, repos.Server, urlSigner)
	authService := services.NewAuthService(
		repos.User, repos.Session, repos.ResetToken, hub, emailSender,
		cfg.JWT.Secret, cfg.JWT.AccessTokenExpiry, cfg.JWT.RefreshTokenExpiry,
	)
	channelService := services.NewChannelService(repos.Channel, repos.Category, hub, channelPermService, voiceService)
	categoryService := services.NewCategoryService(repos.Category, hub)
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.RoleMention, repos.Role, repos.Reaction, repos.ReadState,
		hub, channelPermService, urlSigner,
	)
	uploadService := services.NewUploadService(repos.Attachment, fileLocator, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(repos.User, repos.Role, repos.Ban, repos.Server, hub, voiceService, urlSigner)
	roleService := services.NewRoleService(repos.Role, repos.User, hub)
	serverService := services.NewServerService(
		db, repos.Server, repos.LiveKit, repos.Role, repos.Channel,
		repos.Category, repos.User, inviteService, hub, encryptionKey, urlSigner,
	)
	livekitAdminService := services.NewLiveKitAdminService(
		repos.LiveKit, repos.Server, repos.User, repos.Channel,
		voiceService, encryptionKey, cfg.HetznerAPIToken, urlSigner,
	)
	pinService := services.NewPinService(repos.Pin, repos.Message, repos.Channel, hub, channelPermService, urlSigner)
	searchService := services.NewSearchService(repos.Search, urlSigner)
	readStateService := services.NewReadStateService(repos.ReadState, channelPermService)

	// BlockService before DMService (DMService uses it as BlockChecker)
	blockService := services.NewBlockService(repos.Friendship, repos.User, hub, urlSigner)

	// DMSettingsService before DMService (DMService uses it as DMSettingsUnhider)
	dmSettingsService := services.NewDMSettingsService(repos.DMSettings, repos.DM, hub)

	friendshipService := services.NewFriendshipService(repos.Friendship, repos.User, hub, urlSigner)
	dmService := services.NewDMService(repos.DM, repos.User, hub, blockService, friendshipService, dmSettingsService, urlSigner)
	friendshipService.SetDMAcceptor(dmService) // auto-accept pending DMs when friendship is accepted
	dmUploadService := services.NewDMUploadService(repos.DM, fileLocator, cfg.Upload.MaxSize)
	reactionService := services.NewReactionService(repos.Reaction, repos.Message, repos.Channel, hub, channelPermService)
	serverMuteService := services.NewServerMuteService(repos.ServerMute)
	channelMuteService := services.NewChannelMuteService(repos.ChannelMute)
	reportService := services.NewReportService(repos.Report, repos.User, urlSigner)
	reportUploadService := services.NewReportUploadService(repos.Report, fileLocator, cfg.Upload.MaxSize)

	deviceService := services.NewDeviceService(repos.Device, hub)
	e2eeService := services.NewE2EEService(repos.E2EEBackup, repos.GroupSession, hub)

	adminUserService := services.NewAdminUserService(repos.User, hub, voiceService, emailSender)
	adminServerService := services.NewAdminServerService(repos.Server, repos.User, repos.LiveKit, hub, emailSender)

	linkPreviewService := services.NewLinkPreviewService(repos.LinkPreview)
	badgeService := services.NewBadgeService(repos.Badge, hub)
	preferencesService := services.NewPreferencesService(repos.Preferences)
	appLogService := services.NewAppLogService(repos.AppLog)

	metricsHistoryService := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	feedbackService := services.NewFeedbackService(repos.Feedback)
	feedbackUploadService := services.NewFeedbackUploadService(repos.Feedback, fileLocator, cfg.Upload.MaxSize)
	soundboardService := services.NewSoundboardService(
		repos.Soundboard, repos.User, hub, voiceService, fileLocator, cfg.Upload.MaxSize, urlSigner,
	)
	metricsCollector := services.NewMetricsCollector(
		repos.LiveKit, repos.MetricsHistory,
		5*time.Minute,
		30,
		cfg.HetznerAPIToken,
		voiceService,
	)

	// Rate limiters
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)
	messageLimiter := ratelimit.NewMessageRateLimiter(5, 5*time.Second, 15*time.Second)
	registerLimiter := ratelimit.NewLoginRateLimiter(3, 10*time.Minute)   // 3 registrations per 10 min per IP
	forgotPwdLimiter := ratelimit.NewLoginRateLimiter(3, 5*time.Minute)   // 3 forgot-password per 5 min per IP
	resetPwdLimiter := ratelimit.NewLoginRateLimiter(5, 5*time.Minute)    // 5 reset attempts per 5 min per IP
	feedbackLimiter := ratelimit.NewMessageRateLimiter(2, 1*time.Minute, 30*time.Second) // 2 feedback per min, 30s cooldown

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
		ServerMute:        serverMuteService,
		ChannelMute:       channelMuteService,
		DMSettings:        dmSettingsService,
		Block:             blockService,
		Report:            reportService,
		ReportUpload:      reportUploadService,
		AdminUser:         adminUserService,
		AdminServer:       adminServerService,
		Device:            deviceService,
		E2EE:              e2eeService,
		LinkPreview:       linkPreviewService,
		Badge:             badgeService,
		Preferences:       preferencesService,
		AppLog:            appLogService,
		Feedback:          feedbackService,
		FeedbackUpload:    feedbackUploadService,
		Soundboard:        soundboardService,
	}

	limiters := &RateLimiters{
		Login:     loginLimiter,
		Message:   messageLimiter,
		Register:  registerLimiter,
		ForgotPwd: forgotPwdLimiter,
		ResetPwd:  resetPwdLimiter,
		Feedback:  feedbackLimiter,
	}

	return svcs, limiters, metricsCollector
}
