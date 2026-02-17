// Package handlers — ChannelPermissionHandler: kanal bazlı permission override HTTP endpoint'leri.
//
// Endpoint'ler:
// - GET    /api/channels/{id}/permissions           → ListOverrides
// - PUT    /api/channels/{channelId}/permissions/{roleId}  → SetOverride (UPSERT)
// - DELETE /api/channels/{channelId}/permissions/{roleId}  → DeleteOverride
//
// Tüm endpoint'ler ManageChannels yetkisi gerektirir (middleware seviyesinde).
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ChannelPermissionHandler, kanal permission override endpoint'lerini yöneten struct.
type ChannelPermissionHandler struct {
	service services.ChannelPermissionService
}

// NewChannelPermissionHandler, constructor.
func NewChannelPermissionHandler(service services.ChannelPermissionService) *ChannelPermissionHandler {
	return &ChannelPermissionHandler{service: service}
}

// ListOverrides godoc
// GET /api/channels/{id}/permissions
//
// Bir kanaldaki tüm permission override'ları döner.
// Admin UI'da kullanılır — "bu kanalda hangi roller için override var?"
//
// Response: []ChannelPermissionOverride (boş olabilir)
func (h *ChannelPermissionHandler) ListOverrides(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	overrides, err := h.service.GetOverrides(r.Context(), channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, overrides)
}

// SetOverride godoc
// PUT /api/channels/{channelId}/permissions/{roleId}
// Body: { "allow": 32, "deny": 2048 }
//
// Bir kanal-rol çifti için permission override oluşturur veya günceller (UPSERT).
//
// Kurallar:
// - allow ve deny aynı bit'i set edemez (overlap)
// - Sadece kanal-level permission'lar override edilebilir (ChannelOverridablePerms)
// - allow=0, deny=0 → override'ı siler (inherit'e döner)
//
// Neden PUT?
// Bu endpoint idempotent: aynı request'i tekrar göndermek aynı sonucu verir.
// REST semantiğinde PUT, "bu kaynağı bu state'e getir" anlamına gelir.
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

// DeleteOverride godoc
// DELETE /api/channels/{channelId}/permissions/{roleId}
//
// Bir kanal-rol çifti için permission override'ı siler.
// Silindikten sonra bu rol, kanaldaki yetkilerini global permission'larından alır (inherit).
func (h *ChannelPermissionHandler) DeleteOverride(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	roleID := r.PathValue("roleId")

	if err := h.service.DeleteOverride(r.Context(), channelID, roleID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "override deleted"})
}
