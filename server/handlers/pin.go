package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type PinHandler struct {
	pinService services.PinService
}

func NewPinHandler(pinService services.PinService) *PinHandler {
	return &PinHandler{pinService: pinService}
}

// ListPins handles GET /api/channels/{id}/pins
func (h *PinHandler) ListPins(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	pins, err := h.pinService.GetPinnedMessages(r.Context(), channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, pins)
}

// Pin handles POST /api/channels/{channelId}/messages/{messageId}/pin
// Requires ManageMessages permission.
func (h *PinHandler) Pin(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	messageID := r.PathValue("messageId")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	pin, err := h.pinService.Pin(r.Context(), messageID, channelID, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, pin)
}

// Unpin handles DELETE /api/channels/{channelId}/messages/{messageId}/pin
// Requires ManageMessages permission.
func (h *PinHandler) Unpin(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	messageID := r.PathValue("messageId")

	if err := h.pinService.Unpin(r.Context(), messageID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message unpinned"})
}
