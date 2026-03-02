// Package main — Handler katmanı başlatma.
//
// initHandlers, tüm HTTP handler'larını oluşturur.
// Her handler, ihtiyaç duyduğu service interface'lerini constructor'dan alır.
// Handler'lar "thin" dir — sadece HTTP parse + service call + response write.
package main

import (
	"github.com/akinalp/mqvi/config"
	"github.com/akinalp/mqvi/handlers"
	"github.com/akinalp/mqvi/ws"
)

// Handlers, tüm handler instance'larını tutan container struct.
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
	WS                *ws.Handler
}

// initHandlers, tüm handler'ları service ve rate limiter dependency'leri ile oluşturur.
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
		Admin:             handlers.NewAdminHandler(svcs.LiveKitAdmin, svcs.MetricsHistory),
		ServerMute:        handlers.NewServerMuteHandler(svcs.ServerMute),
		WS:                ws.NewHandler(hub, svcs.Auth, nil, svcs.Voice, repos.User, repos.Server, svcs.ServerMute),
	}
}
