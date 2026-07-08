package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/antivirus"
	"github.com/akinalp/mqvi/pkg/apns"
	"github.com/akinalp/mqvi/pkg/email"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/pkg/push"
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
	UploadPipeline    services.UploadPipeline
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
	TURN              services.ICEServerProvider
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
	Storage           services.StorageService
	Cleanup           services.CleanupService
	SettingsBadge     services.SettingsBadgeService
	VoiceMessage      services.VoiceMessageService
	PushToken         services.PushTokenService
	EmailSender       email.EmailSender
}

type RateLimiters struct {
	Login     *ratelimit.LoginRateLimiter
	Message   *ratelimit.MessageRateLimiter
	Register  *ratelimit.LoginRateLimiter
	ForgotPwd *ratelimit.LoginRateLimiter
	ResetPwd  *ratelimit.LoginRateLimiter
	Feedback  *ratelimit.MessageRateLimiter
	ICE       *ratelimit.MessageRateLimiter
}

// initServices creates all services. Order matters:
// channelPermService -> voiceService/messageService (dependency)
// voiceService/p2pCallService -> before Hub callbacks (closure scoping)
func initServices(db *sql.DB, repos *Repositories, hub ws.EventPublisher, cfg *config.Config, encryptionKey []byte, urlSigner services.FileURLSigner) (*Services, *RateLimiters, services.MetricsCollector) {
	// File locator: single source of truth for upload paths and URLs.
	fileLocator := files.NewLocator(cfg.Upload.Dir, cfg.Upload.PublicURL)

	// Storage quota service
	storageService := services.NewStorageService(repos.Storage, cfg.Upload.DefaultQuotaBytes)
	appLogService := services.NewAppLogService(repos.AppLog)
	avScanner := antivirus.NewClamAVScanner(cfg.Antivirus.ClamAVAddr, time.Duration(cfg.Antivirus.TimeoutSeconds)*time.Second)
	uploadPipeline := services.NewUploadPipeline(fileLocator, avScanner, repos.ScanHashCache, appLogService, cfg.Antivirus)

	// File cleanup service (bulk file deletion + quota release for cascading deletes).
	// Cleanup repo enables the retry queue so failed disk deletes get re-attempted
	// daily by the embedded cleanup worker (Phase 16 P3).
	fileCleanupService := services.NewFileCleanupService(db, fileLocator, storageService, repos.LiveKit, repos.Cleanup)

	// Order-sensitive services
	channelPermService := services.NewChannelPermissionService(
		repos.ChannelPermission, repos.Role, repos.Channel, hub,
	)
	voiceService := services.NewVoiceService(
		repos.Channel, repos.LiveKit, channelPermService, hub, hub, repos.Server, encryptionKey, urlSigner,
	)
	p2pCallService := services.NewP2PCallService(repos.Friendship, repos.User, hub, urlSigner)

	// ICE server provider for P2P calls (STUN + TURN relay fallback).
	turnService := services.NewTURNService(
		cfg.TURN.Secret, cfg.TURN.URLs, cfg.TURN.STUNURLs,
		time.Duration(cfg.TURN.CredentialTTLSeconds)*time.Second,
	)
	// Surface TURN status through the in-app log (viewable in the admin panel),
	// not just stdout — a silent STUN-only degrade should be discoverable.
	// "configured" not "enabled": this only confirms secret+URLs are present, not
	// that coturn is reachable or the secret matches (a reachability/health check
	// would be needed for that).
	if cfg.TURN.Secret != "" && len(cfg.TURN.URLs) > 0 {
		appLogService.Log(models.LogLevelInfo, models.LogCategoryVoice, nil, nil,
			fmt.Sprintf("TURN relay configured: %d server(s), credential TTL %ds", len(cfg.TURN.URLs), cfg.TURN.CredentialTTLSeconds), nil)
	} else {
		appLogService.Log(models.LogLevelInfo, models.LogCategoryVoice, nil, nil,
			"TURN relay not configured — P2P calls use STUN only (no relay fallback)", nil)
	}

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
	channelService := services.NewChannelService(repos.Channel, repos.Category, hub, channelPermService, voiceService, voiceService, fileCleanupService)
	categoryService := services.NewCategoryService(repos.Category, hub)
	messageService := services.NewMessageService(
		repos.Message, repos.Attachment, repos.Channel, repos.User,
		repos.Mention, repos.RoleMention, repos.Role, repos.Reaction, repos.ReadState,
		hub, channelPermService, urlSigner, fileLocator, storageService,
	)
	uploadService := services.NewUploadService(repos.Attachment, uploadPipeline, cfg.Upload.MaxSize)
	memberService := services.NewMemberService(repos.User, repos.Role, repos.Ban, repos.Server, hub, voiceService, voiceService, urlSigner)
	roleService := services.NewRoleService(repos.Role, repos.User, hub)

	// Wire live mid-call voice permission enforcement (S3). Post-construction because
	// voiceService is built after channelPermService (its permission resolver).
	channelPermService.SetVoiceEnforcer(voiceService)
	roleService.SetVoiceEnforcer(voiceService)
	memberService.SetVoiceEnforcer(voiceService)

	// Wire permission-cache invalidation: role perm edits/deletes and member role changes
	// must drop stale cached perms so join/send gates see the change immediately (not ≤30s late).
	roleService.SetPermCacheInvalidator(channelPermService)
	memberService.SetPermCacheInvalidator(channelPermService)
	serverService := services.NewServerService(
		db, repos.Server, repos.LiveKit, repos.Role, repos.Channel,
		repos.Category, repos.User, inviteService, hub, voiceService, voiceService, encryptionKey, urlSigner, fileCleanupService,
	)
	livekitAdminService := services.NewLiveKitAdminService(
		repos.LiveKit, repos.Server, repos.User, repos.Channel,
		voiceService, encryptionKey, cfg.HetznerAPIToken, urlSigner,
		cfg.Upload.DefaultQuotaBytes,
	)
	pinService := services.NewPinService(repos.Pin, repos.Message, repos.Channel, hub, channelPermService, urlSigner)
	searchService := services.NewSearchService(repos.Search, urlSigner)
	readStateService := services.NewReadStateService(repos.ReadState, channelPermService)

	// BlockService before DMService (DMService uses it as BlockChecker)
	blockService := services.NewBlockService(repos.Friendship, repos.User, hub, urlSigner)

	// DMSettingsService before DMService (DMService uses it as DMSettingsUnhider)
	dmSettingsService := services.NewDMSettingsService(repos.DMSettings, repos.DM, hub)

	friendshipService := services.NewFriendshipService(repos.Friendship, repos.User, hub, urlSigner)
	dmService := services.NewDMService(repos.DM, repos.User, hub, blockService, friendshipService, dmSettingsService, urlSigner, fileLocator, storageService)
	friendshipService.SetDMAcceptor(dmService) // auto-accept pending DMs when friendship is accepted
	p2pCallService.SetCallLogger(dmService)    // P2P calls write a call-log entry into the DM history

	// Push notifications (FCM) — optional. A missing/invalid credentials file yields
	// a disabled (no-op) sender; the server still starts.
	pushSender, err := push.NewSender(context.Background(), cfg.Push.CredentialsFile)
	if err != nil {
		log.Printf("[main] push notifications disabled: %v", err)
	} else if pushSender.Enabled() {
		log.Println("[main] push notifications enabled (FCM)")
	} else {
		log.Println("[main] push notifications disabled (no credentials file)")
	}
	apnsSender, err := apns.NewSender(apns.Config{
		KeyPath:    cfg.Push.APNs.KeyPath,
		KeyID:      cfg.Push.APNs.KeyID,
		TeamID:     cfg.Push.APNs.TeamID,
		BundleID:   cfg.Push.APNs.BundleID,
		Production: cfg.Push.APNs.Production,
	})
	if err != nil {
		log.Printf("[main] APNs VoIP (iOS calls) disabled: %v", err)
	} else if apnsSender.Enabled() {
		log.Println("[main] APNs VoIP enabled (iOS CallKit)")
	}
	pushService := services.NewPushService(pushSender, apnsSender, repos.PushToken, repos.User)
	dmService.SetPushNotifier(pushService)
	p2pCallService.SetPushNotifier(pushService)
	dmUploadService := services.NewDMUploadService(repos.DM, uploadPipeline, cfg.Upload.MaxSize)
	reactionService := services.NewReactionService(repos.Reaction, repos.Message, repos.Channel, hub, channelPermService)
	serverMuteService := services.NewServerMuteService(repos.ServerMute)
	channelMuteService := services.NewChannelMuteService(repos.ChannelMute)
	reportService := services.NewReportService(repos.Report, repos.User, urlSigner, emailSender)
	reportUploadService := services.NewReportUploadService(repos.Report, uploadPipeline, cfg.Upload.MaxSize)

	deviceService := services.NewDeviceService(repos.Device, hub)
	e2eeService := services.NewE2EEService(repos.E2EEBackup, repos.GroupSession, channelPermService, hub)
	pushTokenService := services.NewPushTokenService(repos.PushToken)

	adminUserService := services.NewAdminUserService(db, repos.User, repos.Session, repos.Server, hub, voiceService, emailSender, fileCleanupService)
	adminServerService := services.NewAdminServerService(repos.Server, repos.User, repos.LiveKit, hub, voiceService, emailSender, fileCleanupService)

	linkPreviewService := services.NewLinkPreviewService(repos.LinkPreview)
	badgeService := services.NewBadgeService(repos.Badge, hub)
	preferencesService := services.NewPreferencesService(repos.Preferences)
	metricsHistoryService := services.NewMetricsHistoryService(repos.MetricsHistory, repos.LiveKit)
	feedbackService := services.NewFeedbackService(repos.Feedback, repos.User, fileLocator, storageService, emailSender)
	settingsBadgeService := services.NewSettingsBadgeService(repos.User, repos.Feedback, repos.Report)
	voiceMessageService := services.NewVoiceMessageService(repos.VoiceMessage, voiceService, hub, urlSigner, fileLocator)
	// Wipe ephemeral voice chat when the last participant leaves the channel.
	// 5-minute timeout so a hung DB call can't leak the goroutine indefinitely.
	voiceService.SetOnChannelEmpty(func(channelID string) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		voiceMessageService.CleanupChannel(ctx, channelID)
	})
	feedbackUploadService := services.NewFeedbackUploadService(repos.Feedback, uploadPipeline, cfg.Upload.MaxSize)
	soundboardService := services.NewSoundboardService(
		repos.Soundboard, repos.User, hub, voiceService, uploadPipeline, cfg.Upload.MaxSize, urlSigner, storageService,
	)
	metricsCollector := services.NewMetricsCollector(
		repos.LiveKit, repos.MetricsHistory,
		5*time.Minute,
		30,
		cfg.HetznerAPIToken,
		voiceService,
	)
	cleanupService := services.NewCleanupService(
		db, repos.Cleanup, repos.ScanHashCache,
		repos.User, repos.Server,
		adminUserService, adminServerService,
		fileLocator, appLogService,
		cfg.Upload.Dir,
		time.Duration(cfg.Antivirus.CleanCacheTTLHours)*time.Hour,
		time.Duration(cfg.Antivirus.InfectedCacheTTLDays)*24*time.Hour,
	)

	// Rate limiters
	loginLimiter := ratelimit.NewLoginRateLimiter(5, 2*time.Minute)
	messageLimiter := ratelimit.NewMessageRateLimiter(5, 5*time.Second, 15*time.Second)
	registerLimiter := ratelimit.NewLoginRateLimiter(3, 10*time.Minute)                  // 3 registrations per 10 min per IP
	forgotPwdLimiter := ratelimit.NewLoginRateLimiter(3, 5*time.Minute)                  // 3 forgot-password per 5 min per IP
	resetPwdLimiter := ratelimit.NewLoginRateLimiter(5, 5*time.Minute)                   // 5 reset attempts per 5 min per IP
	feedbackLimiter := ratelimit.NewMessageRateLimiter(2, 1*time.Minute, 30*time.Second) // 2 feedback per min, 30s cooldown
	iceLimiter := ratelimit.NewMessageRateLimiter(20, 1*time.Minute, 30*time.Second)     // 20 ICE-server fetches per min, 30s cooldown

	svcs := &Services{
		Auth:              authService,
		Server:            serverService,
		Channel:           channelService,
		Category:          categoryService,
		Message:           messageService,
		Upload:            uploadService,
		DMUpload:          dmUploadService,
		UploadPipeline:    uploadPipeline,
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
		TURN:              turnService,
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
		Storage:           storageService,
		Cleanup:           cleanupService,
		SettingsBadge:     settingsBadgeService,
		VoiceMessage:      voiceMessageService,
		PushToken:         pushTokenService,
		EmailSender:       emailSender,
	}

	limiters := &RateLimiters{
		Login:     loginLimiter,
		Message:   messageLimiter,
		Register:  registerLimiter,
		ForgotPwd: forgotPwdLimiter,
		ResetPwd:  resetPwdLimiter,
		Feedback:  feedbackLimiter,
		ICE:       iceLimiter,
	}

	return svcs, limiters, metricsCollector
}
