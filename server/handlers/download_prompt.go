package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// DownloadPromptHandler handles POST /api/users/me/dismiss-download-prompt.
type DownloadPromptHandler struct {
	userRepo repository.UserRepository
}

func NewDownloadPromptHandler(userRepo repository.UserRepository) *DownloadPromptHandler {
	return &DownloadPromptHandler{userRepo: userRepo}
}

// Dismiss marks the download prompt as seen so it won't show again.
func (h *DownloadPromptHandler) Dismiss(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.userRepo.SetDownloadPromptSeen(r.Context(), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "dismissed"})
}

// DismissWelcome marks the welcome modal as seen so it won't show again.
func (h *DownloadPromptHandler) DismissWelcome(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.userRepo.SetWelcomeSeen(r.Context(), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "dismissed"})
}
