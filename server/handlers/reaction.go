package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type ReactionHandler struct {
	reactionService services.ReactionService
}

func NewReactionHandler(reactionService services.ReactionService) *ReactionHandler {
	return &ReactionHandler{reactionService: reactionService}
}

type toggleRequest struct {
	Emoji string `json:"emoji"`
}

// Toggle handles POST /api/messages/{messageId}/reactions
// Adds or removes a reaction (toggle). Emoji sent in body to avoid URL encoding issues.
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
