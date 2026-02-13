// Package handlers — InviteHandler: davet kodu HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Tüm endpoint'ler auth + ManageInvites permission gerektirir.
//
// Route'lar (main.go'da bağlanır):
//   GET    /api/invites       → List
//   POST   /api/invites       → Create
//   DELETE /api/invites/{code} → Delete
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
// GET /api/invites
// Tüm davet kodlarını oluşturan kullanıcı bilgisiyle döner.
func (h *InviteHandler) List(w http.ResponseWriter, r *http.Request) {
	invites, err := h.inviteService.List(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, invites)
}

// Create godoc
// POST /api/invites
// Body: { "max_uses": 5, "expires_in": 1440 }
// expires_in dakika cinsinden (1440 = 24 saat), 0 = süresiz
func (h *InviteHandler) Create(w http.ResponseWriter, r *http.Request) {
	// Context'ten user bilgisini al (auth middleware tarafından eklenir)
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	invite, err := h.inviteService.Create(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, invite)
}

// Delete godoc
// DELETE /api/invites/{code}
// URL'deki {code} path parameter'ını kullanır.
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
