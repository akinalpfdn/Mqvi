package main

import (
	"net/http"

	"github.com/akinalp/mqvi/middleware"
	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/repository"
	"github.com/akinalp/mqvi/services"
)

// initRoutes registers all API endpoints.
// Literal paths must be registered before parametric ones
// (e.g. "/api/servers/join" before "/api/servers/{serverId}").
func initRoutes(
	mux *http.ServeMux,
	h *Handlers,
	authService services.AuthService,
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	serverRepo repository.ServerRepository,
) {
	// Middleware
	authMw := middleware.NewAuthMiddleware(authService, userRepo)
	permMw := middleware.NewPermissionMiddleware(roleRepo)
	serverMw := middleware.NewServerMembershipMiddleware(serverRepo)
	platformAdminMw := middleware.NewPlatformAdminMiddleware()

	// Middleware chain helpers
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
	// ║  GLOBAL ROUTES (server-independent)       ║
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
	mux.Handle("GET /api/users/me/preferences", auth(h.Preferences.Get))
	mux.Handle("POST /api/users/me/dismiss-download-prompt", auth(h.DownloadPrompt.Dismiss))
	mux.Handle("PATCH /api/users/me/preferences", auth(h.Preferences.Update))

	// Servers
	mux.Handle("GET /api/servers", auth(h.Server.ListMyServers))
	mux.Handle("POST /api/servers", auth(h.Server.CreateServer))
	mux.Handle("POST /api/servers/join", auth(h.Server.JoinServer))
	mux.Handle("PATCH /api/servers/reorder", auth(h.Server.ReorderServers))

	// Server mutes — literal path before {serverId} wildcard
	mux.Handle("GET /api/servers/mutes", auth(h.ServerMute.ListMuted))

	// Upload
	mux.Handle("POST /api/upload", auth(h.Message.Upload))

	// DMs — literal paths before parametric
	mux.Handle("GET /api/dms/settings", auth(h.DMSettings.GetSettings))
	mux.Handle("GET /api/dms", auth(h.DM.ListChannels))
	mux.Handle("POST /api/dms", auth(h.DM.CreateOrGetChannel))

	// DM Settings — /api/dms/channels/ prefix avoids route ambiguity with /api/dms/{channelId}
	mux.Handle("POST /api/dms/channels/{channelId}/hide", auth(h.DMSettings.HideDM))
	mux.Handle("DELETE /api/dms/channels/{channelId}/hide", auth(h.DMSettings.UnhideDM))
	mux.Handle("POST /api/dms/channels/{channelId}/pin-conversation", auth(h.DMSettings.PinConversation))
	mux.Handle("DELETE /api/dms/channels/{channelId}/pin-conversation", auth(h.DMSettings.UnpinConversation))
	mux.Handle("POST /api/dms/channels/{channelId}/mute", auth(h.DMSettings.MuteDM))
	mux.Handle("DELETE /api/dms/channels/{channelId}/mute", auth(h.DMSettings.UnmuteDM))

	// DM Messages
	mux.Handle("GET /api/dms/{channelId}/messages", auth(h.DM.GetMessages))
	mux.Handle("POST /api/dms/{channelId}/messages", auth(h.DM.SendMessage))
	mux.Handle("PATCH /api/dms/messages/{id}", auth(h.DM.EditMessage))
	mux.Handle("DELETE /api/dms/messages/{id}", auth(h.DM.DeleteMessage))
	mux.Handle("POST /api/dms/messages/{id}/reactions", auth(h.DM.ToggleReaction))
	mux.Handle("POST /api/dms/messages/{id}/pin", auth(h.DM.PinMessage))
	mux.Handle("DELETE /api/dms/messages/{id}/pin", auth(h.DM.UnpinMessage))
	mux.Handle("GET /api/dms/{channelId}/pinned", auth(h.DM.GetPinnedMessages))
	mux.Handle("GET /api/dms/{channelId}/search", auth(h.DM.SearchMessages))
	mux.Handle("PATCH /api/dms/channels/{channelId}/e2ee", auth(h.DM.ToggleE2EE))

	// Block — literal "blocked" before parametric {userId}
	mux.Handle("GET /api/users/blocked", auth(h.Block.ListBlocked))
	mux.Handle("POST /api/users/{userId}/block", auth(h.Block.BlockUser))
	mux.Handle("DELETE /api/users/{userId}/block", auth(h.Block.UnblockUser))

	// Report
	mux.Handle("POST /api/users/{userId}/report", auth(h.Report.CreateReport))

	// Feedback
	mux.Handle("POST /api/feedback", auth(h.Feedback.CreateTicket))
	mux.Handle("GET /api/feedback", auth(h.Feedback.ListMyTickets))
	mux.Handle("GET /api/feedback/{id}", auth(h.Feedback.GetTicket))
	mux.Handle("POST /api/feedback/{id}/reply", auth(h.Feedback.AddReply))

	// E2EE Devices
	mux.Handle("GET /api/devices", auth(h.Device.List))
	mux.Handle("POST /api/devices", auth(h.Device.Register))
	mux.Handle("DELETE /api/devices/{deviceId}", auth(h.Device.Delete))
	mux.Handle("POST /api/devices/{deviceId}/prekeys", auth(h.Device.UploadPrekeys))
	mux.Handle("PUT /api/devices/{deviceId}/signed-prekey", auth(h.Device.UpdateSignedPrekey))
	mux.Handle("GET /api/devices/{deviceId}/prekey-count", auth(h.Device.GetPrekeyCount))

	// E2EE Key Backup
	mux.Handle("PUT /api/e2ee/key-backup", auth(h.E2EE.UpsertKeyBackup))
	mux.Handle("GET /api/e2ee/key-backup", auth(h.E2EE.GetKeyBackup))
	mux.Handle("DELETE /api/e2ee/key-backup", auth(h.E2EE.DeleteKeyBackup))

	// E2EE User Devices / Prekey Bundles
	mux.Handle("GET /api/users/{userId}/devices", auth(h.Device.ListPublicDevices))
	mux.Handle("GET /api/users/{userId}/prekey-bundles", auth(h.Device.GetPrekeyBundles))

	// Channel mutes — literal path before {serverId} wildcard
	mux.Handle("GET /api/channels/mutes", auth(h.ChannelMute.ListMuted))

	// Link Preview
	mux.Handle("GET /api/link-preview", auth(h.LinkPreview.Get))

	// Badges — literal paths before parametric
	mux.Handle("GET /api/badges", auth(h.Badge.ListBadges))
	mux.Handle("POST /api/badges", auth(h.Badge.CreateBadge))
	mux.Handle("POST /api/badges/icon", auth(h.Badge.UploadBadgeIcon))
	mux.Handle("PATCH /api/badges/{id}", auth(h.Badge.UpdateBadge))
	mux.Handle("DELETE /api/badges/{id}", auth(h.Badge.DeleteBadge))
	mux.Handle("POST /api/badges/{id}/assign", auth(h.Badge.AssignBadge))
	mux.Handle("DELETE /api/badges/{id}/assign/{userId}", auth(h.Badge.UnassignBadge))
	mux.Handle("GET /api/users/{userId}/badges", auth(h.Badge.GetUserBadges))

	// GIFs (Klipy proxy)
	mux.Handle("GET /api/gifs/trending", auth(h.Gif.Trending))
	mux.Handle("GET /api/gifs/search", auth(h.Gif.Search))

	// Friends
	mux.Handle("GET /api/friends/requests", auth(h.Friendship.ListRequests))
	mux.Handle("POST /api/friends/requests", auth(h.Friendship.SendRequest))
	mux.Handle("POST /api/friends/requests/{id}/accept", auth(h.Friendship.AcceptRequest))
	mux.Handle("DELETE /api/friends/requests/{id}", auth(h.Friendship.DeclineRequest))
	mux.Handle("GET /api/friends", auth(h.Friendship.ListFriends))
	mux.Handle("DELETE /api/friends/{userId}", auth(h.Friendship.RemoveFriend))

	// Platform Admin — LiveKit
	mux.Handle("GET /api/admin/livekit-instances", authAdmin(h.Admin.ListLiveKitInstances))
	mux.Handle("GET /api/admin/livekit-instances/{id}/metrics/timeseries", authAdmin(h.Admin.GetLiveKitInstanceMetricsTimeSeries))
	mux.Handle("GET /api/admin/livekit-instances/{id}/metrics/history", authAdmin(h.Admin.GetLiveKitInstanceMetricsHistory))
	mux.Handle("GET /api/admin/livekit-instances/{id}/metrics", authAdmin(h.Admin.GetLiveKitInstanceMetrics))
	mux.Handle("GET /api/admin/livekit-instances/{id}", authAdmin(h.Admin.GetLiveKitInstance))
	mux.Handle("POST /api/admin/livekit-instances", authAdmin(h.Admin.CreateLiveKitInstance))
	mux.Handle("PATCH /api/admin/livekit-instances/{id}", authAdmin(h.Admin.UpdateLiveKitInstance))
	mux.Handle("DELETE /api/admin/livekit-instances/{id}", authAdmin(h.Admin.DeleteLiveKitInstance))

	// Platform Admin — Servers
	mux.Handle("GET /api/admin/servers", authAdmin(h.Admin.ListServers))
	mux.Handle("PATCH /api/admin/servers/{serverId}/instance", authAdmin(h.Admin.MigrateServerInstance))
	mux.Handle("DELETE /api/admin/servers/{serverId}", authAdmin(h.Admin.AdminDeleteServer))

	// Platform Admin — Reports
	mux.Handle("GET /api/admin/reports", authAdmin(h.Admin.ListReports))
	mux.Handle("PATCH /api/admin/reports/{id}/status", authAdmin(h.Admin.UpdateReportStatus))

	// Platform Admin — Feedback
	mux.Handle("GET /api/admin/feedback", authAdmin(h.Feedback.AdminListTickets))
	mux.Handle("GET /api/admin/feedback/{id}", authAdmin(h.Feedback.AdminGetTicket))
	mux.Handle("POST /api/admin/feedback/{id}/reply", authAdmin(h.Feedback.AdminReply))
	mux.Handle("PATCH /api/admin/feedback/{id}/status", authAdmin(h.Feedback.AdminUpdateStatus))

	// Platform Admin — Users
	mux.Handle("GET /api/admin/users", authAdmin(h.Admin.ListUsers))
	mux.Handle("POST /api/admin/users/{id}/ban", authAdmin(h.Admin.PlatformBanUser))
	mux.Handle("DELETE /api/admin/users/{id}/ban", authAdmin(h.Admin.PlatformUnbanUser))
	mux.Handle("DELETE /api/admin/users/{id}", authAdmin(h.Admin.HardDeleteUser))
	mux.Handle("PATCH /api/admin/users/{id}/platform-admin", authAdmin(h.Admin.SetUserPlatformAdmin))

	// Platform Admin — App Logs
	mux.Handle("GET /api/admin/logs", authAdmin(h.Admin.ListAppLogs))
	mux.Handle("DELETE /api/admin/logs", authAdmin(h.Admin.ClearAppLogs))

	// Stats — public
	mux.HandleFunc("GET /api/stats", h.Stats.GetPublicStats)

	// Invite Preview — public (no auth)
	mux.HandleFunc("GET /api/invites/{code}/preview", h.Invite.Preview)

	// ╔══════════════════════════════════════════╗
	// ║  SERVER-SCOPED ROUTES                     ║
	// ╚══════════════════════════════════════════╝

	// Server
	mux.Handle("GET /api/servers/{serverId}", authServer(h.Server.GetServer))
	mux.Handle("PATCH /api/servers/{serverId}", authServerPerm(models.PermAdmin, h.Server.UpdateServer))
	mux.Handle("DELETE /api/servers/{serverId}", authServer(h.Server.DeleteServer))
	mux.Handle("POST /api/servers/{serverId}/leave", authServer(h.Server.LeaveServer))
	mux.Handle("POST /api/servers/{serverId}/icon", authServerPerm(models.PermAdmin, h.Avatar.UploadServerIcon))

	// Server Mute
	mux.Handle("POST /api/servers/{serverId}/mute", authServer(h.ServerMute.Mute))
	mux.Handle("DELETE /api/servers/{serverId}/mute", authServer(h.ServerMute.Unmute))

	// Channel Mute
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/mute", authServer(h.ChannelMute.Mute))
	mux.Handle("DELETE /api/servers/{serverId}/channels/{id}/mute", authServer(h.ChannelMute.Unmute))

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
	mux.Handle("PATCH /api/servers/{serverId}/categories/reorder", authServerPerm(models.PermManageChannels, h.Category.Reorder))

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

	// Read State — literal "read-all" and "unread" before {id} wildcard
	mux.Handle("POST /api/servers/{serverId}/channels/read-all", authServer(h.ReadState.MarkAllRead))
	mux.Handle("GET /api/servers/{serverId}/channels/unread", authServer(h.ReadState.GetUnreads))
	mux.Handle("POST /api/servers/{serverId}/channels/{id}/read", authServer(h.ReadState.MarkRead))

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

	// E2EE Group Sessions
	mux.Handle("POST /api/servers/{serverId}/channels/{channelId}/group-sessions", authServer(h.E2EE.CreateGroupSession))
	mux.Handle("GET /api/servers/{serverId}/channels/{channelId}/group-sessions", authServer(h.E2EE.GetGroupSessions))

	// Search
	mux.Handle("GET /api/servers/{serverId}/search", authServer(h.Search.Search))

	// Voice
	mux.Handle("POST /api/servers/{serverId}/voice/token", authServer(h.Voice.Token))
	mux.Handle("POST /api/servers/{serverId}/voice/screen-token", authServer(h.Voice.ScreenShareToken))
	mux.Handle("GET /api/servers/{serverId}/voice/states", authServer(h.Voice.VoiceStates))

	// WebSocket
	mux.HandleFunc("GET /ws", h.WS.HandleConnection)
}
