package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ChannelMuteHandler, kanal sessize alma endpoint'lerini yöneten struct.
type ChannelMuteHandler struct {
	muteService services.ChannelMuteService
}

// NewChannelMuteHandler, constructor.
func NewChannelMuteHandler(muteService services.ChannelMuteService) *ChannelMuteHandler {
	return &ChannelMuteHandler{muteService: muteService}
}

// Mute godoc
// POST /api/servers/{serverId}/channels/{id}/mute
// Kullanıcı belirli bir kanalı sessize alır.
// Body: {"duration": "1h" | "8h" | "7d" | "forever"}
func (h *ChannelMuteHandler) Mute(w http.ResponseWriter, r *http.Request) {
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

	channelID := r.PathValue("id")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel id required")
		return
	}

	var req models.MuteChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.muteService.MuteChannel(r.Context(), user.ID, channelID, serverID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "channel muted"})
}

// Unmute godoc
// DELETE /api/servers/{serverId}/channels/{id}/mute
// Kanal sessizliğini kaldırır.
func (h *ChannelMuteHandler) Unmute(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("id")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel id required")
		return
	}

	if err := h.muteService.UnmuteChannel(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "channel unmuted"})
}

// ListMuted godoc
// GET /api/channels/mutes
// Kullanıcının sessize aldığı kanal ID'lerini döner.
func (h *ChannelMuteHandler) ListMuted(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	ids, err := h.muteService.GetMutedChannelIDs(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if ids == nil {
		ids = []string{}
	}

	pkg.JSON(w, http.StatusOK, ids)
}
