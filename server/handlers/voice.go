package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type VoiceHandler struct {
	voiceService services.VoiceService
}

func NewVoiceHandler(voiceService services.VoiceService) *VoiceHandler {
	return &VoiceHandler{voiceService: voiceService}
}

// Token handles POST /api/servers/{serverId}/voice/token
// Generates a LiveKit JWT for the server's LiveKit instance.
func (h *VoiceHandler) Token(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.VoiceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.ChannelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return
	}

	var displayName string
	if user.DisplayName != nil {
		displayName = *user.DisplayName
	}
	resp, err := h.voiceService.GenerateToken(r.Context(), user.ID, user.Username, displayName, req.ChannelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, resp)
}

// VoiceStates handles GET /api/servers/{serverId}/voice/states
// Returns all active voice states (used on connect/reconnect to sync UI).
func (h *VoiceHandler) VoiceStates(w http.ResponseWriter, r *http.Request) {
	states := h.voiceService.GetAllVoiceStates()
	pkg.JSON(w, http.StatusOK, states)
}
