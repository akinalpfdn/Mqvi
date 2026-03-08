package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ServerHandler handles server CRUD, join/leave, and reorder endpoints.
type ServerHandler struct {
	serverService services.ServerService
}

func NewServerHandler(serverService services.ServerService) *ServerHandler {
	return &ServerHandler{serverService: serverService}
}

// ListMyServers returns all servers the user is a member of.
// GET /api/servers
func (h *ServerHandler) ListMyServers(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	servers, err := h.serverService.GetUserServers(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, servers)
}

// CreateServer creates a new server. Creator becomes owner + member.
// POST /api/servers
// Body: { "name": "...", "host_type": "mqvi_hosted"|"self_hosted", ... }
func (h *ServerHandler) CreateServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	server, err := h.serverService.CreateServer(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, server)
}

// JoinServer joins a server via invite code.
// POST /api/servers/join
// Body: { "invite_code": "abc123" }
func (h *ServerHandler) JoinServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.JoinServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	server, err := h.serverService.JoinServer(r.Context(), user.ID, req.InviteCode)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// GetServer returns server details. Protected by membership middleware.
// GET /api/servers/{serverId}
func (h *ServerHandler) GetServer(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	server, err := h.serverService.GetServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// UpdateServer updates server settings. Requires admin permission.
// PATCH /api/servers/{serverId}
func (h *ServerHandler) UpdateServer(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.UpdateServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	server, err := h.serverService.UpdateServer(r.Context(), serverID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// DeleteServer deletes a server. Owner only.
// DELETE /api/servers/{serverId}
func (h *ServerHandler) DeleteServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	if err := h.serverService.DeleteServer(r.Context(), serverID, user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server deleted"})
}

// LeaveServer leaves a server. Owner cannot leave -- must transfer ownership first.
// POST /api/servers/{serverId}/leave
func (h *ServerHandler) LeaveServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	if err := h.serverService.LeaveServer(r.Context(), serverID, user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "left server"})
}

// ReorderServers reorders the user's personal server list.
// PATCH /api/servers/reorder
// Body: { "items": [{ "id": "serverId", "position": 0 }, ...] }
func (h *ServerHandler) ReorderServers(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ReorderServersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	servers, err := h.serverService.ReorderServers(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, servers)
}

// GetLiveKitSettings returns server's LiveKit config (URL + managed status).
// Secrets are excluded. Requires admin permission.
// GET /api/servers/{serverId}/livekit
func (h *ServerHandler) GetLiveKitSettings(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	settings, err := h.serverService.GetLiveKitSettings(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, settings)
}
