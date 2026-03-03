// Package handlers — DMSettingsHandler: DM kanal ayarları endpoint'leri.
//
// Thin handler — parse + service call + response.
// Endpoint'ler:
//   POST   /api/dms/{channelId}/hide         → DM'yi gizle
//   DELETE /api/dms/{channelId}/hide         → DM'yi göster
//   POST   /api/dms/{channelId}/pin-conversation   → DM'yi sabitle
//   DELETE /api/dms/{channelId}/pin-conversation   → Sabitlemeyi kaldır
//   POST   /api/dms/{channelId}/mute         → DM'yi sessize al
//   DELETE /api/dms/{channelId}/mute         → Sessize almayı kaldır
//   GET    /api/dms/settings                 → Pinned + muted DM ID'leri (initial load)
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// DMSettingsHandler, DM ayar endpoint'lerini yöneten struct.
type DMSettingsHandler struct {
	service services.DMSettingsService
}

// NewDMSettingsHandler, constructor.
func NewDMSettingsHandler(service services.DMSettingsService) *DMSettingsHandler {
	return &DMSettingsHandler{service: service}
}

// GetSettings godoc
// GET /api/dms/settings
// Kullanıcının pinned + muted DM kanal ID'lerini döner (initial load).
func (h *DMSettingsHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	settings, err := h.service.GetDMSettings(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, settings)
}

// HideDM godoc
// POST /api/dms/{channelId}/hide
func (h *DMSettingsHandler) HideDM(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")
	if err := h.service.HideDM(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UnhideDM godoc
// DELETE /api/dms/{channelId}/hide
func (h *DMSettingsHandler) UnhideDM(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")
	if err := h.service.UnhideDM(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// PinConversation godoc
// POST /api/dms/{channelId}/pin-conversation
func (h *DMSettingsHandler) PinConversation(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")
	if err := h.service.PinDM(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UnpinConversation godoc
// DELETE /api/dms/{channelId}/pin-conversation
func (h *DMSettingsHandler) UnpinConversation(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")
	if err := h.service.UnpinDM(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// MuteDM godoc
// POST /api/dms/{channelId}/mute
// Body: { "duration": "1h" | "8h" | "7d" | "forever" }
func (h *DMSettingsHandler) MuteDM(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")

	var req models.MuteDMRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	mutedUntil := req.ParseMutedUntil()

	if err := h.service.MuteDM(r.Context(), user.ID, channelID, mutedUntil); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UnmuteDM godoc
// DELETE /api/dms/{channelId}/mute
func (h *DMSettingsHandler) UnmuteDM(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channelID := r.PathValue("channelId")
	if err := h.service.UnmuteDM(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
