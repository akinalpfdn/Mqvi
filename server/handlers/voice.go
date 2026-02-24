// Package handlers, voice (ses) HTTP endpoint'lerini yönetir.
//
// Handler'lar "ince" olmalıdır:
// - Request parse et
// - Service çağır
// - Response yaz
//
// İş mantığı (permission kontrolü, token oluşturma) burada değil,
// VoiceService'te yaşar. Handler sadece HTTP request/response köprüsüdür.
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
// Constructor injection: VoiceService interface'i parametre olarak alınır.
func NewVoiceHandler(voiceService services.VoiceService) *VoiceHandler {
	return &VoiceHandler{voiceService: voiceService}
}

// Token, ses kanalına katılmak için LiveKit JWT token oluşturur.
//
//	POST /api/voice/token
//	Request:  { "channel_id": "abc123" }
//	Response: { "token": "eyJ...", "url": "ws://localhost:7880", "channel_id": "abc123" }
//
// Permission kontrolü (PermConnectVoice, PermSpeak, PermStream)
// VoiceService.GenerateToken içinde yapılır — handler sadece iletir.
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

	// display_name varsa onu tercih et, yoksa username kullanılır (service katmanında).
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
//	GET /api/voice/states
//	Response: [ { "user_id": "...", "channel_id": "...", ... } ]
func (h *VoiceHandler) VoiceStates(w http.ResponseWriter, r *http.Request) {
	states := h.voiceService.GetAllVoiceStates()
	pkg.JSON(w, http.StatusOK, states)
}
