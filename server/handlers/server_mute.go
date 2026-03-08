package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ServerMuteHandler handles server mute/unmute endpoints.
type ServerMuteHandler struct {
	muteService services.ServerMuteService
}

func NewServerMuteHandler(muteService services.ServerMuteService) *ServerMuteHandler {
	return &ServerMuteHandler{muteService: muteService}
}

// Mute mutes a server for the current user.
// POST /api/servers/{serverId}/mute
// Body: {"duration": "1h" | "8h" | "7d" | "forever"}
func (h *ServerMuteHandler) Mute(w http.ResponseWriter, r *http.Request) {
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

	var req models.MuteServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.muteService.MuteServer(r.Context(), user.ID, serverID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server muted"})
}

// Unmute removes server mute for the current user.
// DELETE /api/servers/{serverId}/mute
func (h *ServerMuteHandler) Unmute(w http.ResponseWriter, r *http.Request) {
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

	if err := h.muteService.UnmuteServer(r.Context(), user.ID, serverID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "server unmuted"})
}

// ListMuted returns muted server IDs for the current user.
// GET /api/servers/mutes
func (h *ServerMuteHandler) ListMuted(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	ids, err := h.muteService.GetMutedServerIDs(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if ids == nil {
		ids = []string{}
	}

	pkg.JSON(w, http.StatusOK, ids)
}
