// Package handlers — MemberHandler: üye yönetimi HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Tüm iş mantığı (hiyerarşi kontrolü, ban, kick) MemberService'dedir.
//
// Context'ten user bilgisi almak:
// AuthMiddleware her protected endpoint'te context'e *models.User ekler.
// Handler'da `r.Context().Value(UserContextKey)` ile alırız.
// Bu bilgi actorID (işlemi yapan kişi) olarak service'e iletilir.
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// MemberHandler, üye endpoint'lerini yöneten struct.
type MemberHandler struct {
	memberService services.MemberService
}

// NewMemberHandler, constructor.
func NewMemberHandler(memberService services.MemberService) *MemberHandler {
	return &MemberHandler{memberService: memberService}
}

// List godoc
// GET /api/members
// Tüm üyeleri rolleriyle birlikte döner.
func (h *MemberHandler) List(w http.ResponseWriter, r *http.Request) {
	members, err := h.memberService.GetAll(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, members)
}

// Get godoc
// GET /api/members/{id}
// Belirli bir üyeyi rolleriyle birlikte döner.
func (h *MemberHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	member, err := h.memberService.GetByID(r.Context(), id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// ModifyRoles godoc
// PATCH /api/members/{id}/roles
// Body: { "role_ids": ["roleId1", "roleId2"] }
//
// Bir üyenin rollerini değiştirir.
// Actor (işlemi yapan) context'teki user'dır.
// Target (hedef) URL'deki {id}'dir.
// Hiyerarşi kontrolü MemberService'de yapılır.
func (h *MemberHandler) ModifyRoles(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("id")

	var req models.RoleModifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	member, err := h.memberService.ModifyRoles(r.Context(), actor.ID, targetID, req.RoleIDs)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// Kick godoc
// DELETE /api/members/{id}
// Bir üyeyi sunucudan çıkarır.
// KICK_MEMBERS yetkisi + hiyerarşi kontrolü gerektirir.
func (h *MemberHandler) Kick(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("id")

	if err := h.memberService.Kick(r.Context(), actor.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member kicked"})
}

// Ban godoc
// POST /api/members/{id}/ban
// Body: { "reason": "optional ban reason" }
//
// Bir üyeyi yasaklar. BAN_MEMBERS yetkisi + hiyerarşi kontrolü gerektirir.
func (h *MemberHandler) Ban(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("id")

	var req models.BanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.memberService.Ban(r.Context(), actor.ID, targetID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member banned"})
}

// GetBans godoc
// GET /api/bans
// Tüm yasaklı üyeleri listeler. BAN_MEMBERS yetkisi gerektirir.
func (h *MemberHandler) GetBans(w http.ResponseWriter, r *http.Request) {
	bans, err := h.memberService.GetBans(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, bans)
}

// Unban godoc
// DELETE /api/bans/{id}
// Bir üyenin yasağını kaldırır. BAN_MEMBERS yetkisi gerektirir.
func (h *MemberHandler) Unban(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")

	if err := h.memberService.Unban(r.Context(), userID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member unbanned"})
}

// UpdateProfile godoc
// PATCH /api/users/me/profile
// Body: { "display_name": "...", "avatar_url": "...", "custom_status": "..." }
//
// Kullanıcının kendi profilini günceller.
// Başkasının profilini güncelleyemezsin — her zaman context'teki user'ın bilgileri güncellenir.
func (h *MemberHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}
