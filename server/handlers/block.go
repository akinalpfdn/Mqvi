// Package handlers — BlockHandler: kullanıcı engelleme endpoint'leri.
//
// Endpoint'ler:
//   POST   /api/users/{userId}/block   → Kullanıcıyı engelle
//   DELETE /api/users/{userId}/block   → Engeli kaldır
//   GET    /api/users/blocked          → Engellenen kullanıcıları listele
package handlers

import (
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// BlockHandler, kullanıcı engelleme endpoint'lerini yöneten struct.
type BlockHandler struct {
	service services.BlockService
}

// NewBlockHandler, constructor.
func NewBlockHandler(service services.BlockService) *BlockHandler {
	return &BlockHandler{service: service}
}

// BlockUser godoc
// POST /api/users/{userId}/block
func (h *BlockHandler) BlockUser(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("userId")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "userId is required")
		return
	}

	if err := h.service.BlockUser(r.Context(), user.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UnblockUser godoc
// DELETE /api/users/{userId}/block
func (h *BlockHandler) UnblockUser(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("userId")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "userId is required")
		return
	}

	if err := h.service.UnblockUser(r.Context(), user.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListBlocked godoc
// GET /api/users/blocked
func (h *BlockHandler) ListBlocked(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	blocked, err := h.service.ListBlocked(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, blocked)
}
