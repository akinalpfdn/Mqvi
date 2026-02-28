// Package handlers — MemberHandler: üye yönetimi HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Tüm iş mantığı (hiyerarşi kontrolü, ban, kick) MemberService'dedir.
//
// Multi-server mimaride tüm üye operasyonları sunucu bazlıdır.
// ServerID context'ten alınır (ServerMembershipMiddleware tarafından eklenir).
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
// GET /api/servers/{serverId}/members
// Sunucudaki tüm üyeleri rolleriyle birlikte döner.
func (h *MemberHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	members, err := h.memberService.GetAll(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, members)
}

// Get godoc
// GET /api/servers/{serverId}/members/{id}
// Belirli bir üyeyi rolleriyle birlikte döner.
func (h *MemberHandler) Get(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	id := r.PathValue("id")

	member, err := h.memberService.GetByID(r.Context(), serverID, id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// ModifyRoles godoc
// PATCH /api/servers/{serverId}/members/{id}/roles
// Body: { "role_ids": ["roleId1", "roleId2"] }
func (h *MemberHandler) ModifyRoles(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	var req models.RoleModifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	member, err := h.memberService.ModifyRoles(r.Context(), serverID, actor.ID, targetID, req.RoleIDs)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// Kick godoc
// DELETE /api/servers/{serverId}/members/{id}
// Bir üyeyi sunucudan çıkarır.
func (h *MemberHandler) Kick(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	if err := h.memberService.Kick(r.Context(), serverID, actor.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member kicked"})
}

// Ban godoc
// POST /api/servers/{serverId}/members/{id}/ban
// Body: { "reason": "optional ban reason" }
func (h *MemberHandler) Ban(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	var req models.BanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.memberService.Ban(r.Context(), serverID, actor.ID, targetID, req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member banned"})
}

// GetBans godoc
// GET /api/servers/{serverId}/bans
// Tüm yasaklı üyeleri listeler. BAN_MEMBERS yetkisi gerektirir.
func (h *MemberHandler) GetBans(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	bans, err := h.memberService.GetBans(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, bans)
}

// Unban godoc
// DELETE /api/servers/{serverId}/bans/{id}
// Bir üyenin yasağını kaldırır. BAN_MEMBERS yetkisi gerektirir.
func (h *MemberHandler) Unban(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	userID := r.PathValue("id")

	if err := h.memberService.Unban(r.Context(), serverID, userID); err != nil {
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
// Bu endpoint global — sunucu bağımsız (profil tüm sunucularda aynı).
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
