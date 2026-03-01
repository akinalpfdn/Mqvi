// Package main — HTTP route registration.
//
// initRoutes, tüm API endpoint'lerini mux'a bağlar.
// Middleware chain helper'ları burada tanımlıdır:
//   - auth: JWT token doğrulaması
//   - authServer: auth + sunucu üyelik kontrolü
//   - authServerPerm: auth + sunucu üyelik + belirli permission kontrolü
//   - authAdmin: auth + platform admin yetkisi
package main

import (
	"net/http"

	"github.com/akinalp/mqvi/middleware"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

// initRoutes, middleware chain'i kurar ve tüm endpoint'leri mux'a bağlar.
//
// Route sıralama kuralı: Literal path'ler parametrik path'lerden ÖNCE tanımlanmalı.
// Örnek: "/api/servers/join" → "/api/servers/{serverId}" öncesinde,
// yoksa Go router "join" kelimesini bir serverId olarak yorumlar.
func initRoutes(
	mux *http.ServeMux,
	h *Handlers,
	authService services.AuthService,
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	serverRepo repository.ServerRepository,
) {
	// ─── Middleware ───
	authMw := middleware.NewAuthMiddleware(authService, userRepo)
	permMw := middleware.NewPermissionMiddleware(roleRepo)
	serverMw := middleware.NewServerMembershipMiddleware(serverRepo)
	platformAdminMw := middleware.NewPlatformAdminMiddleware()

	// ─── Middleware Chain Helpers ───
	auth := func(handler http.HandlerFunc) http.Handler {
		return authMw.Require(http.HandlerFunc(handler))
	}
	authServer := func(handler http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(http.HandlerFunc(handler)))
	}
	authServerPerm := func(perm models.Permission, handler http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(permMw.Require(perm, http.HandlerFunc(handler))))
	}
	authServerPermLoad := func(handler http.HandlerFunc) http.Handler {
		return authMw.Require(serverMw.Require(permMw.Load(http.HandlerFunc(handler))))
	}
	authAdmin := func(handler http.HandlerFunc) http.Handler {
		return authMw.Require(platformAdminMw.Require(http.HandlerFunc(handler)))
	}

	// ╔══════════════════════════════════════════╗
	// ║  GLOBAL ROUTES (sunucu bağımsız)         ║
	// ╚══════════════════════════════════════════╝

	// Auth
	mux.HandleFunc("POST /api/auth/register", h.Auth.Register)
	mux.HandleFunc("POST /api/auth/login", h.Auth.Login)
	mux.HandleFunc("POST /api/auth/refresh", h.Auth.Refresh)
	mux.Handle("POST /api/auth/logout", auth(h.Auth.Logout))
	mux.HandleFunc("POST /api/auth/forgot-password", h.Auth.ForgotPassword)
	mux.HandleFunc("POST /api/auth/reset-password", h.Auth.ResetPassword)

	// User
	mux.Handle("GET /api/users/me", auth(h.Auth.Me))
	mux.Handle("PATCH /api/users/me/profile", auth(h.Member.UpdateProfile))
	mux.Handle("POST /api/users/me/password", auth(h.Auth.ChangePassword))
	mux.Handle("PUT /api/users/me/email", auth(h.Auth.ChangeEmail))
	mux.Handle("POST /api/users/me/avatar", auth(h.Avatar.UploadUserAvatar))

	// Servers — sunucu listesi, oluşturma, katılma
	mux.Handle("GET /api/servers", auth(h.Server.ListMyServers))
	mux.Handle("POST /api/servers", auth(h.Server.CreateServer))
	mux.Handle("POST /api/servers/join", auth(h.Server.JoinServer))
	mux.Handle("PATCH /api/servers/reorder", auth(h.Server.ReorderServers))

	// Upload
	mux.Handle("POST /api/upload", auth(h.Message.Upload))

	// DMs
	mux.Handle("GET /api/dms", auth(h.DM.ListChannels))
	mux.Handle("POST /api/dms", auth(h.DM.CreateOrGetChannel))
	mux.Handle("GET /api/dms/{channelId}/messages", auth(h.DM.GetMessages))
	mux.Handle("POST /api/dms/{channelId}/messages", auth(h.DM.SendMessage))
	mux.Handle("PATCH /api/dms/messages/{id}", auth(h.DM.EditMessage))
	mux.Handle("DELETE /api/dms/messages/{id}", auth(h.DM.DeleteMessage))
	mux.Handle("POST /api/dms/messages/{id}/reactions", auth(h.DM.ToggleReaction))
	mux.Handle("POST /api/dms/messages/{id}/pin", auth(h.DM.PinMessage))
	mux.Handle("DELETE /api/dms/messages/{id}/pin", auth(h.DM.UnpinMessage))
	mux.Handle("GET /api/dms/{channelId}/pinned", auth(h.DM.GetPinnedMessages))
	mux.Handle("GET /api/dms/{channelId}/search", auth(h.DM.SearchMessages))

	// Friends
	mux.Handle("GET /api/friends/requests", auth(h.Friendship.ListRequests))
	mux.Handle("POST /api/friends/requests", auth(h.Friendship.SendRequest))
	mux.Handle("POST /api/friends/requests/{id}/accept", auth(h.Friendship.AcceptRequest))
	mux.Handle("DELETE /api/friends/requests/{id}", auth(h.Friendship.DeclineRequest))
	mux.Handle("GET /api/friends", auth(h.Friendship.ListFriends))
	mux.Handle("DELETE /api/friends/{userId}", auth(h.Friendship.RemoveFriend))

	// Platform Admin — LiveKit instance yönetimi
	mux.Handle("GET /api/admin/livekit-instances", authAdmin(h.Admin.ListLiveKitInstances))
	mux.Handle("GET /api/admin/livekit-instances/{id}/metrics", authAdmin(h.Admin.GetLiveKitInstanceMetrics))
	mux.Handle("GET /api/admin/livekit-instances/{id}", authAdmin(h.Admin.GetLiveKitInstance))
	mux.Handle("POST /api/admin/livekit-instances", authAdmin(h.Admin.CreateLiveKitInstance))
	mux.Handle("PATCH /api/admin/livekit-instances/{id}", authAdmin(h.Admin.UpdateLiveKitInstance))
	mux.Handle("DELETE /api/admin/livekit-instances/{id}", authAdmin(h.Admin.DeleteLiveKitInstance))

	// Platform Admin — Sunucu listesi + instance migration
	mux.Handle("GET /api/admin/servers", authAdmin(h.Admin.ListServers))
	mux.Handle("PATCH /api/admin/servers/{serverId}/instance", authAdmin(h.Admin.MigrateServerInstance))

	// Platform Admin — Kullanıcı listesi
	mux.Handle("GET /api/admin/users", authAdmin(h.Admin.ListUsers))

	// Stats — public
	mux.HandleFunc("GET /api/stats", h.Stats.GetPublicStats)

	// ╔══════════════════════════════════════════╗
	// ║  SERVER-SCOPED ROUTES                     ║
	// ╚══════════════════════════════════════════╝

	// Server
	mux.Handle("GET /api/servers/{serverId}", authServer(h.Server.GetServer))
	mux.Handle("PATCH /api/servers/{serverId}", authServerPerm(models.PermAdmin, h.Server.UpdateServer))
	mux.Handle("DELETE /api/servers/{serverId}", authServer(h.Server.DeleteServer))
	mux.Handle("POST /api/servers/{serverId}/leave", authServer(h.Server.LeaveServer))
	mux.Handle("POST /api/servers/{serverId}/icon", authServerPerm(models.PermAdmin, h.Avatar.UploadServerIcon))

	// LiveKit settings
	mux.Handle("GET /api/servers/{serverId}/livekit", authServerPerm(models.PermAdmin, h.Server.GetLiveKitSettings))

	// Channels
	mux.Handle("GET /api/servers/{serverId}/channels", authServer(h.Channel.List))
	mux.Handle("POST /api/servers/{serverId}/channels", authServerPerm(models.PermManageChannels, h.Channel.Create))
	mux.Handle("PATCH /api/servers/{serverId}/channels/reorder", authServerPerm(models.PermManageChannels, h.Channel.Reorder))
	mux.Handle("PATCH /api/servers/{serverId}/channels/{id}", authServerPerm(models.PermManageChannels, h.Channel.Update))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{id}", authServerPerm(models.PermManageChannels, h.Channel.Delete))

	// Categories
	mux.Handle("GET /api/servers/{serverId}/categories", authServer(h.Category.List))
	mux.Handle("POST /api/servers/{serverId}/categories", authServerPerm(models.PermManageChannels, h.Category.Create))
	mux.Handle("PATCH /api/servers/{serverId}/categories/{id}", authServerPerm(models.PermManageChannels, h.Category.Update))
	mux.Handle("DELETE /api/servers/{serverId}/categories/{id}", authServerPerm(models.PermManageChannels, h.Category.Delete))

	// Messages
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/messages", authServer(h.Message.List))
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/messages", authServer(h.Message.Create))
	mux.Handle("PATCH /api/servers/{serverId}/messages/{id}", authServer(h.Message.Update))
	mux.Handle("DELETE /api/servers/{serverId}/messages/{id}", authServerPermLoad(h.Message.Delete))

	// Reactions
	mux.Handle("POST /api/servers/{serverId}/messages/{messageId}/reactions", authServer(h.Reaction.Toggle))

	// Pins
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/pins", authServer(h.Pin.ListPins))
	mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", authServerPerm(models.PermManageMessages, h.Pin.Pin))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/messages/{messageId}/pin", authServerPerm(models.PermManageMessages, h.Pin.Unpin))

	// Read State
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/read", authServer(h.ReadState.MarkRead))
	mux.Handle("GET /api/servers/{serverId}/channels/unread", authServer(h.ReadState.GetUnreads))

	// Members
	mux.Handle("GET /api/servers/{serverId}/members", authServer(h.Member.List))
	mux.Handle("GET /api/servers/{serverId}/members/{id}", authServer(h.Member.Get))
	mux.Handle("PATCH /api/servers/{serverId}/members/{id}/roles", authServerPerm(models.PermManageRoles, h.Member.ModifyRoles))
	mux.Handle("DELETE /api/servers/{serverId}/members/{id}", authServerPerm(models.PermKickMembers, h.Member.Kick))
	mux.Handle("POST /api/servers/{serverId}/members/{id}/ban", authServerPerm(models.PermBanMembers, h.Member.Ban))

	// Bans
	mux.Handle("GET /api/servers/{serverId}/bans", authServerPerm(models.PermBanMembers, h.Member.GetBans))
	mux.Handle("DELETE /api/servers/{serverId}/bans/{id}", authServerPerm(models.PermBanMembers, h.Member.Unban))

	// Roles
	mux.Handle("GET /api/servers/{serverId}/roles", authServer(h.Role.List))
	mux.Handle("POST /api/servers/{serverId}/roles", authServerPerm(models.PermManageRoles, h.Role.Create))
	mux.Handle("PATCH /api/servers/{serverId}/roles/reorder", authServerPerm(models.PermManageRoles, h.Role.Reorder))
	mux.Handle("PATCH /api/servers/{serverId}/roles/{id}", authServerPerm(models.PermManageRoles, h.Role.Update))
	mux.Handle("DELETE /api/servers/{serverId}/roles/{id}", authServerPerm(models.PermManageRoles, h.Role.Delete))

	// Channel Permissions
	mux.Handle("GET /api/servers/{serverId}/channels/{id}/permissions", authServer(h.ChannelPermission.ListOverrides))
	mux.Handle("PUT /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", authServerPerm(models.PermManageChannels, h.ChannelPermission.SetOverride))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{channelId}/permissions/{roleId}", authServerPerm(models.PermManageChannels, h.ChannelPermission.DeleteOverride))

	// Invites
	mux.Handle("GET /api/servers/{serverId}/invites", authServerPerm(models.PermManageInvites, h.Invite.List))
	mux.Handle("POST /api/servers/{serverId}/invites", authServerPerm(models.PermManageInvites, h.Invite.Create))
	mux.Handle("DELETE /api/servers/{serverId}/invites/{code}", authServerPerm(models.PermManageInvites, h.Invite.Delete))

	// Search
	mux.Handle("GET /api/servers/{serverId}/search", authServer(h.Search.Search))

	// Voice
	mux.Handle("POST /api/servers/{serverId}/voice/token", authServer(h.Voice.Token))
	mux.Handle("GET /api/servers/{serverId}/voice/states", authServer(h.Voice.VoiceStates))

	// WebSocket
	mux.HandleFunc("GET /ws", h.WS.HandleConnection)
}
