package main

import (
	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/handlers"
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
	WS                *ws.Handler
}

func initHandlers(svcs *Services, repos *Repositories, limiters *RateLimiters, hub *ws.Hub, cfg *config.Config) *Handlers {
	return &Handlers{
		Auth:              handlers.NewAuthHandler(svcs.Auth, limiters.Login),
		Channel:           handlers.NewChannelHandler(svcs.Channel),
		Category:          handlers.NewCategoryHandler(svcs.Category),
		Message:           handlers.NewMessageHandler(svcs.Message, svcs.Upload, cfg.Upload.MaxSize, limiters.Message),
		Member:            handlers.NewMemberHandler(svcs.Member),
		Role:              handlers.NewRoleHandler(svcs.Role),
		Voice:             handlers.NewVoiceHandler(svcs.Voice),
		Server:            handlers.NewServerHandler(svcs.Server),
		Invite:            handlers.NewInviteHandler(svcs.Invite),
		Pin:               handlers.NewPinHandler(svcs.Pin),
		Search:            handlers.NewSearchHandler(svcs.Search),
		ReadState:         handlers.NewReadStateHandler(svcs.ReadState),
		DM:                handlers.NewDMHandler(svcs.DM, svcs.DMUpload, cfg.Upload.MaxSize, limiters.Message),
		Reaction:          handlers.NewReactionHandler(svcs.Reaction),
		ChannelPermission: handlers.NewChannelPermissionHandler(svcs.ChannelPermission),
		Friendship:        handlers.NewFriendshipHandler(svcs.Friendship),
		Avatar:            handlers.NewAvatarHandler(repos.User, svcs.Member, svcs.Server, cfg.Upload.Dir),
		Stats:             handlers.NewStatsHandler(repos.User),
		Admin:             handlers.NewAdminHandler(svcs.LiveKitAdmin, svcs.MetricsHistory, svcs.AdminUser, svcs.AdminServer, svcs.Report),
		ServerMute:        handlers.NewServerMuteHandler(svcs.ServerMute),
		ChannelMute:       handlers.NewChannelMuteHandler(svcs.ChannelMute),
		DMSettings:        handlers.NewDMSettingsHandler(svcs.DMSettings),
		Block:             handlers.NewBlockHandler(svcs.Block),
		Report:            handlers.NewReportHandler(svcs.Report, svcs.ReportUpload, cfg.Upload.MaxSize),
		Gif:               handlers.NewGifHandler(cfg.Klipy.APIKey),
		Device:            handlers.NewDeviceHandler(svcs.Device),
		E2EE:              handlers.NewE2EEHandler(svcs.E2EE),
		LinkPreview:       handlers.NewLinkPreviewHandler(svcs.LinkPreview),
		Badge:             handlers.NewBadgeHandler(svcs.Badge, cfg.Upload.Dir),
		Preferences:       handlers.NewPreferencesHandler(svcs.Preferences),
		WS:                ws.NewHandler(hub, svcs.Auth, nil, svcs.Voice, repos.User, repos.Server, svcs.ServerMute, svcs.ChannelMute),
	}
}
