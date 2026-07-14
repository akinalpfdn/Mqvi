package main

import (
	"time"

	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/services"
	"github.com/akinalp/mqvi/ws"
)

// Handlers holds all HTTP handler instances.
type Handlers struct {
	Auth              *handlers.AuthHandler
	Channel           *handlers.ChannelHandler
	Category          *handlers.CategoryHandler
	Message           *handlers.MessageHandler
	Member            *handlers.MemberHandler
	Role              *handlers.RoleHandler
	Voice             *handlers.VoiceHandler
	Server            *handlers.ServerHandler
	Invite            *handlers.InviteHandler
	Pin               *handlers.PinHandler
	Search            *handlers.SearchHandler
	ReadState         *handlers.ReadStateHandler
	DM                *handlers.DMHandler
	Reaction          *handlers.ReactionHandler
	ChannelPermission *handlers.ChannelPermissionHandler
	Friendship        *handlers.FriendshipHandler
	Avatar            *handlers.AvatarHandler
	Stats             *handlers.StatsHandler
	Admin             *handlers.AdminHandler
	ServerMute        *handlers.ServerMuteHandler
	ChannelMute       *handlers.ChannelMuteHandler
	DMSettings        *handlers.DMSettingsHandler
	Block             *handlers.BlockHandler
	Report            *handlers.ReportHandler
	Gif               *handlers.GifHandler
	Device            *handlers.DeviceHandler
	E2EE              *handlers.E2EEHandler
	LinkPreview       *handlers.LinkPreviewHandler
	Badge             *handlers.BadgeHandler
	Preferences       *handlers.PreferencesHandler
	DownloadPrompt    *handlers.DownloadPromptHandler
	Feedback          *handlers.FeedbackHandler
	Soundboard        *handlers.SoundboardHandler
	Storage           *handlers.StorageHandler
	LiveKitWebhook    *handlers.LiveKitWebhookHandler
	VoiceMessage      *handlers.VoiceMessageHandler
	ICEServer         *handlers.ICEServerHandler
	PushToken         *handlers.PushTokenHandler
	Discovery         *handlers.DiscoveryHandler
	AssetLinks        *handlers.AssetLinksHandler
	WS                *ws.Handler
}

func initHandlers(svcs *Services, repos *Repositories, limiters *RateLimiters, hub *ws.Hub, cfg *config.Config, encryptionKey []byte, urlSigner services.FileURLSigner) *Handlers {
	fileLocator := files.NewLocator(cfg.Upload.Dir, cfg.Upload.PublicURL)
	h := &Handlers{
		Auth:              handlers.NewAuthHandler(svcs.Auth, limiters.Login, limiters.Register, limiters.ForgotPwd, limiters.ResetPwd, urlSigner, time.Duration(cfg.JWT.RefreshTokenExpiry)*24*time.Hour),
		Channel:           handlers.NewChannelHandler(svcs.Channel),
		Category:          handlers.NewCategoryHandler(svcs.Category),
		Message:           handlers.NewMessageHandler(svcs.Message, svcs.Upload, svcs.Storage, cfg.Upload.MaxSize, limiters.Message, urlSigner),
		Member:            handlers.NewMemberHandler(svcs.Member),
		Role:              handlers.NewRoleHandler(svcs.Role),
		Voice:             handlers.NewVoiceHandler(svcs.Voice, urlSigner),
		Server:            handlers.NewServerHandler(svcs.Server),
		Discovery:         handlers.NewDiscoveryHandler(svcs.Discovery, svcs.Server, svcs.Report, svcs.ServerReportUpload, svcs.Storage, urlSigner, cfg.Upload.MaxSize, limiters.Discovery),
		Invite:            handlers.NewInviteHandler(svcs.Invite),
		Pin:               handlers.NewPinHandler(svcs.Pin),
		Search:            handlers.NewSearchHandler(svcs.Search),
		ReadState:         handlers.NewReadStateHandler(svcs.ReadState, limiters.ChannelRead),
		DM:                handlers.NewDMHandler(svcs.DM, svcs.DMUpload, svcs.Storage, cfg.Upload.MaxSize, limiters.Message, limiters.DMRead, urlSigner),
		Reaction:          handlers.NewReactionHandler(svcs.Reaction),
		ChannelPermission: handlers.NewChannelPermissionHandler(svcs.ChannelPermission),
		Friendship:        handlers.NewFriendshipHandler(svcs.Friendship),
		Avatar:            handlers.NewAvatarHandler(repos.User, svcs.Member, svcs.Server, fileLocator, svcs.UploadPipeline, urlSigner),
		Stats:             handlers.NewStatsHandler(repos.User),
		Admin:             handlers.NewAdminHandler(svcs.LiveKitAdmin, svcs.MetricsHistory, svcs.AdminUser, svcs.AdminServer, svcs.Report, svcs.AppLog, svcs.SettingsBadge, svcs.Voice),
		ServerMute:        handlers.NewServerMuteHandler(svcs.ServerMute),
		ChannelMute:       handlers.NewChannelMuteHandler(svcs.ChannelMute),
		DMSettings:        handlers.NewDMSettingsHandler(svcs.DMSettings),
		Block:             handlers.NewBlockHandler(svcs.Block),
		Report:            handlers.NewReportHandler(svcs.Report, svcs.ReportUpload, svcs.Storage, cfg.Upload.MaxSize, urlSigner),
		Gif:               handlers.NewGifHandler(cfg.Klipy.APIKey),
		AssetLinks:        handlers.NewAssetLinksHandler(cfg.AppLinks.AndroidPackage, cfg.AppLinks.AndroidFingerprints),
		Device:            handlers.NewDeviceHandler(svcs.Device),
		E2EE:              handlers.NewE2EEHandler(svcs.E2EE),
		LinkPreview:       handlers.NewLinkPreviewHandler(svcs.LinkPreview),
		Badge:             handlers.NewBadgeHandler(svcs.Badge, svcs.UploadPipeline),
		Preferences:       handlers.NewPreferencesHandler(svcs.Preferences),
		DownloadPrompt:    handlers.NewDownloadPromptHandler(repos.User),
		Feedback:          handlers.NewFeedbackHandler(svcs.Feedback, svcs.FeedbackUpload, svcs.Storage, svcs.SettingsBadge, cfg.Upload.MaxSize, limiters.Feedback, svcs.AppLog, urlSigner),
		Soundboard:        handlers.NewSoundboardHandler(svcs.Soundboard, svcs.Storage, cfg.Upload.MaxSize, urlSigner),
		Storage:           handlers.NewStorageHandler(svcs.Storage),
		LiveKitWebhook:    handlers.NewLiveKitWebhookHandler(repos.LiveKit, encryptionKey, svcs.AppLog),
		VoiceMessage:      handlers.NewVoiceMessageHandler(svcs.VoiceMessage, svcs.UploadPipeline, urlSigner, limiters.Message, cfg.Upload.MaxSize),
		ICEServer:         handlers.NewICEServerHandler(svcs.TURN, svcs.P2PCall, limiters.ICE),
		PushToken:         handlers.NewPushTokenHandler(svcs.PushToken),
		WS:                ws.NewHandler(hub, svcs.Auth, nil, svcs.Voice, repos.User, repos.Server, svcs.ServerMute, svcs.ChannelMute, urlSigner),
	}
	// Re-deliver a ringing incoming call to a receiver on (re)connect (offline/push tap).
	h.WS.SetIncomingCallProvider(svcs.P2PCall)
	return h
}
