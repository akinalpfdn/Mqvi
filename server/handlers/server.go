// Package handlers — ServerHandler: sunucu yönetimi HTTP endpoint'leri.
//
// Multi-server mimaride sunucu oluşturma, listeleme, güncelleme, silme,
// davet ile katılma ve sunucudan ayrılma endpoint'lerini yönetir.
//
// Route'lar:
//   GET    /api/servers              → kullanıcının sunucu listesi
//   POST   /api/servers              → yeni sunucu oluştur
//   POST   /api/servers/join         → davet koduyla katıl
//   GET    /api/servers/{serverId}   → sunucu detayı (membership required)
//   PATCH  /api/servers/{serverId}   → sunucu güncelle (Admin perm required)
//   DELETE /api/servers/{serverId}   → sunucu sil (owner only)
//   POST   /api/servers/{serverId}/leave → sunucudan ayrıl
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ServerHandler, sunucu yönetimi endpoint'lerini yönetir.
type ServerHandler struct {
	serverService services.ServerService
}

// NewServerHandler, constructor.
func NewServerHandler(serverService services.ServerService) *ServerHandler {
	return &ServerHandler{serverService: serverService}
}

// ListMyServers godoc
// GET /api/servers
// Kullanıcının üye olduğu tüm sunucuları döner (server list sidebar için).
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

// CreateServer godoc
// POST /api/servers
// Body: { "name": "...", "host_type": "mqvi_hosted"|"self_hosted", ... }
//
// Yeni sunucu oluşturur. Oluşturan kişi otomatik owner + üye olur.
// Self-hosted ise LiveKit credential'ları gerekir.
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

// JoinServer godoc
// POST /api/servers/join
// Body: { "invite_code": "abc123" }
//
// Davet koduyla sunucuya katılır. Kod geçerliyse kullanıcı sunucuya eklenir.
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

// GetServer godoc
// GET /api/servers/{serverId}
// Sunucu detayını döner. Membership middleware ile korunur.
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

// UpdateServer godoc
// PATCH /api/servers/{serverId}
// Body: { "name": "...", "invite_required": true }
//
// Sunucu bilgisini günceller. Admin yetkisi gerektirir.
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

// DeleteServer godoc
// DELETE /api/servers/{serverId}
// Sunucuyu siler. Sadece owner yapabilir.
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

// LeaveServer godoc
// POST /api/servers/{serverId}/leave
// Sunucudan ayrılır. Owner ayrılamaz — önce sahiplik devretmeli.
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
