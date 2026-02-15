package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ReactionHandler, emoji reaction endpoint'lerini yöneten struct.
//
// Thin handler pattern: sadece HTTP request parse + response yazımı yapar.
// Tüm iş mantığı (emoji validation, toggle, broadcast) ReactionService'de.
type ReactionHandler struct {
	reactionService services.ReactionService
}

// NewReactionHandler, constructor.
func NewReactionHandler(reactionService services.ReactionService) *ReactionHandler {
	return &ReactionHandler{reactionService: reactionService}
}

// toggleRequest, Toggle endpoint'inin beklediği JSON body.
type toggleRequest struct {
	Emoji string `json:"emoji"`
}

// Toggle godoc
// POST /api/messages/{messageId}/reactions
//
// Bir mesaja emoji reaction ekler veya kaldırır (toggle pattern).
// Aynı endpoint'e aynı emoji ile tekrar istek atılırsa reaction kaldırılır.
// Bu sayede frontend tek bir buton ile hem ekle hem kaldır yapabilir.
//
// Path parametreleri:
//   - messageId: Reaction eklenecek mesajın ID'si
//
// Body:
//
//	{ "emoji": "👍" }
//
// Emoji body'de gönderilir (URL path'te emoji encoding sorunları yaratabilir).
func (h *ReactionHandler) Toggle(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")

	var body toggleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.reactionService.ToggleReaction(r.Context(), messageID, user.ID, body.Emoji); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "reaction toggled"})
}
