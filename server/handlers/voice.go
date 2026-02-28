// Package handlers, voice (ses) HTTP endpoint'lerini yönetir.
//
// Handler'lar "ince" olmalıdır:
// - Request parse et
// - Service çağır
// - Response yaz
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// VoiceHandler, ses kanalı HTTP endpoint'lerini yönetir.
type VoiceHandler struct {
	voiceService services.VoiceService
}

// NewVoiceHandler, yeni bir VoiceHandler oluşturur.
func NewVoiceHandler(voiceService services.VoiceService) *VoiceHandler {
	return &VoiceHandler{voiceService: voiceService}
}

// Token, ses kanalına katılmak için LiveKit JWT token oluşturur.
//
//	POST /api/servers/{serverId}/voice/token
//	Request:  { "channel_id": "abc123" }
//	Response: { "token": "eyJ...", "url": "ws://livekit-url", "channel_id": "abc123" }
//
// Per-server LiveKit: token, sunucuya bağlı LiveKit instance üzerinden üretilir.
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

// VoiceStates, tüm aktif ses durumlarını döner.
// İlk bağlantı veya reconnect sonrası frontend bu endpoint'i çağırarak
// hangi kullanıcıların hangi ses kanallarında olduğunu öğrenir.
//
//	GET /api/servers/{serverId}/voice/states
//	Response: [ { "user_id": "...", "channel_id": "...", ... } ]
func (h *VoiceHandler) VoiceStates(w http.ResponseWriter, r *http.Request) {
	states := h.voiceService.GetAllVoiceStates()
	pkg.JSON(w, http.StatusOK, states)
}
