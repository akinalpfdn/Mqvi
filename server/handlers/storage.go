package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type StorageHandler struct {
	storageService services.StorageService
}

func NewStorageHandler(storageService services.StorageService) *StorageHandler {
	return &StorageHandler{storageService: storageService}
}

// GetUsage returns the current user's storage usage.
// GET /api/users/me/storage
func (h *StorageHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	usage, err := h.storageService.GetUsage(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"bytes_used":  usage.BytesUsed,
		"quota_bytes": usage.QuotaBytes,
	})
}

// AdminSetQuota updates a user's storage quota.
// PATCH /api/admin/users/{userId}/quota
func (h *StorageHandler) AdminSetQuota(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	if userID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	var req struct {
		QuotaBytes int64 `json:"quota_bytes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.QuotaBytes <= 0 {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "quota_bytes must be positive")
		return
	}

	if err := h.storageService.SetQuota(r.Context(), userID, req.QuotaBytes); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "quota updated"})
}
