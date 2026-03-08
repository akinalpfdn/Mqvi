package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ChannelPermissionHandler handles per-channel permission override endpoints.
// All endpoints require ManageChannels permission (enforced by middleware).
type ChannelPermissionHandler struct {
	service services.ChannelPermissionService
}

func NewChannelPermissionHandler(service services.ChannelPermissionService) *ChannelPermissionHandler {
	return &ChannelPermissionHandler{service: service}
}

// ListOverrides handles GET /api/channels/{id}/permissions
func (h *ChannelPermissionHandler) ListOverrides(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	overrides, err := h.service.GetOverrides(r.Context(), channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, overrides)
}

// SetOverride handles PUT /api/channels/{channelId}/permissions/{roleId}
// Upserts a permission override. allow and deny must not overlap.
// Only channel-level permissions (ChannelOverridablePerms) can be overridden.
// allow=0, deny=0 deletes the override (reverts to inherit).
func (h *ChannelPermissionHandler) SetOverride(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	roleID := r.PathValue("roleId")

	var req models.SetOverrideRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.service.SetOverride(r.Context(), channelID, roleID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "override updated"})
}

// DeleteOverride handles DELETE /api/channels/{channelId}/permissions/{roleId}
// Removes the override; the role falls back to its global permissions.
func (h *ChannelPermissionHandler) DeleteOverride(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	roleID := r.PathValue("roleId")

	if err := h.service.DeleteOverride(r.Context(), channelID, roleID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "override deleted"})
}
