// Package handlers — AdminHandler, platform admin endpoint'leri.
//
// Bu handler sadece platform admin kullanıcılar tarafından erişilebilir.
// PlatformAdminMiddleware tarafından korunur.
//
// Thin handler pattern: parse request → call service → return response.
// Business logic service katmanındadır.
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// AdminHandler, platform admin endpoint'lerini yönetir.
type AdminHandler struct {
	livekitAdminService services.LiveKitAdminService
}

// NewAdminHandler, constructor.
func NewAdminHandler(livekitAdminService services.LiveKitAdminService) *AdminHandler {
	return &AdminHandler{livekitAdminService: livekitAdminService}
}

// ListLiveKitInstances — GET /api/admin/livekit-instances
// Tüm platform-managed LiveKit instance'larını listeler.
func (h *AdminHandler) ListLiveKitInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := h.livekitAdminService.ListInstances(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instances)
}

// GetLiveKitInstance — GET /api/admin/livekit-instances/{id}
// Tek bir LiveKit instance'ı döner.
func (h *AdminHandler) GetLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	instance, err := h.livekitAdminService.GetInstance(r.Context(), id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instance)
}

// CreateLiveKitInstance — POST /api/admin/livekit-instances
// Yeni bir platform-managed LiveKit instance oluşturur.
func (h *AdminHandler) CreateLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	var req models.CreateLiveKitInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	instance, err := h.livekitAdminService.CreateInstance(r.Context(), &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, instance)
}

// UpdateLiveKitInstance — PATCH /api/admin/livekit-instances/{id}
// Mevcut bir LiveKit instance'ı günceller.
func (h *AdminHandler) UpdateLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	var req models.UpdateLiveKitInstanceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	instance, err := h.livekitAdminService.UpdateInstance(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, instance)
}

// DeleteLiveKitInstance — DELETE /api/admin/livekit-instances/{id}?migrate_to={targetId}
// Bir LiveKit instance'ı siler.
// Bağlı sunucular varsa migrate_to query parametresi ile hedef instance belirtilmelidir.
func (h *AdminHandler) DeleteLiveKitInstance(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "instance id is required")
		return
	}

	migrateToID := r.URL.Query().Get("migrate_to")

	if err := h.livekitAdminService.DeleteInstance(r.Context(), id, migrateToID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "instance deleted"})
}
