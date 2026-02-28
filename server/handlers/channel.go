package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ChannelHandler, kanal endpoint'lerini yöneten struct.
type ChannelHandler struct {
	channelService services.ChannelService
}

// NewChannelHandler, constructor.
func NewChannelHandler(channelService services.ChannelService) *ChannelHandler {
	return &ChannelHandler{channelService: channelService}
}

// List godoc
// GET /api/servers/{serverId}/channels
// Kullanıcının görebileceği kanalları kategorilere göre gruplar ve döner.
// ViewChannel yetkisi olmayan kanallar filtrelenir (sidebar'da gizli kalır).
func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	grouped, err := h.channelService.GetAllGrouped(r.Context(), serverID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, grouped)
}

// Create godoc
// POST /api/servers/{serverId}/channels
// Yeni kanal oluşturur. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.channelService.Create(r.Context(), serverID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, channel)
}

// Update godoc
// PATCH /api/servers/{serverId}/channels/{id}
// Kanalı günceller. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req models.UpdateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.channelService.Update(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// Delete godoc
// DELETE /api/servers/{serverId}/channels/{id}
// Kanalı siler. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if err := h.channelService.Delete(r.Context(), id); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "channel deleted"})
}

// Reorder godoc
// PATCH /api/servers/{serverId}/channels/reorder
// Kanal sıralamasını toplu olarak günceller. MANAGE_CHANNELS yetkisi gerektirir.
func (h *ChannelHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.ReorderChannelsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	grouped, err := h.channelService.ReorderChannels(r.Context(), serverID, &req, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, grouped)
}
