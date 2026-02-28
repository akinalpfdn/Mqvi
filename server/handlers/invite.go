// Package handlers — InviteHandler: davet kodu HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Tüm endpoint'ler auth + ServerMembership + ManageInvites permission gerektirir.
//
// Route'lar:
//   GET    /api/servers/{serverId}/invites       → List
//   POST   /api/servers/{serverId}/invites       → Create
//   DELETE /api/servers/{serverId}/invites/{code} → Delete
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// InviteHandler, davet kodu endpoint'lerini yöneten struct.
type InviteHandler struct {
	inviteService services.InviteService
}

// NewInviteHandler, constructor.
func NewInviteHandler(inviteService services.InviteService) *InviteHandler {
	return &InviteHandler{inviteService: inviteService}
}

// List godoc
// GET /api/servers/{serverId}/invites
// Sunucunun tüm davet kodlarını oluşturan kullanıcı bilgisiyle döner.
func (h *InviteHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	invites, err := h.inviteService.ListByServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, invites)
}

// Create godoc
// POST /api/servers/{serverId}/invites
// Body: { "max_uses": 5, "expires_in": 1440 }
func (h *InviteHandler) Create(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.CreateInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	invite, err := h.inviteService.Create(r.Context(), serverID, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, invite)
}

// Delete godoc
// DELETE /api/servers/{serverId}/invites/{code}
func (h *InviteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if code == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invite code is required")
		return
	}

	if err := h.inviteService.Delete(r.Context(), code); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "invite deleted"})
}
