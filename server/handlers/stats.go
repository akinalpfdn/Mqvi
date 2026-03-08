package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

type StatsResponse struct {
	TotalUsers int `json:"total_users"`
}

// StatsHandler serves public stats (no auth required). Used by the landing page.
type StatsHandler struct {
	userRepo repository.UserRepository
}

func NewStatsHandler(userRepo repository.UserRepository) *StatsHandler {
	return &StatsHandler{userRepo: userRepo}
}

// GetPublicStats returns total registered user count.
// GET /api/stats
func (h *StatsHandler) GetPublicStats(w http.ResponseWriter, r *http.Request) {
	count, err := h.userRepo.Count(r.Context())
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "failed to get stats")
		return
	}

	pkg.JSON(w, http.StatusOK, StatsResponse{TotalUsers: count})
}
