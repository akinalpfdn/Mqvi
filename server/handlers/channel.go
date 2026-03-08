package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type ChannelHandler struct {
	channelService services.ChannelService
}

func NewChannelHandler(channelService services.ChannelService) *ChannelHandler {
	return &ChannelHandler{channelService: channelService}
}

// List handles GET /api/servers/{serverId}/channels
// Returns channels grouped by category, filtered by ViewChannel permission.
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

// Create handles POST /api/servers/{serverId}/channels (requires MANAGE_CHANNELS).
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

// Update handles PATCH /api/servers/{serverId}/channels/{id} (requires MANAGE_CHANNELS).
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

// Delete handles DELETE /api/servers/{serverId}/channels/{id} (requires MANAGE_CHANNELS).
func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if err := h.channelService.Delete(r.Context(), id); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "channel deleted"})
}

// Reorder handles PATCH /api/servers/{serverId}/channels/reorder (requires MANAGE_CHANNELS).
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
