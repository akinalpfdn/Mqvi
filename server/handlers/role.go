// Package handlers — RoleHandler: rol yönetimi HTTP endpoint'leri.
//
// Tüm CUD (Create, Update, Delete) endpoint'leri MANAGE_ROLES yetkisi gerektirir.
// Ek olarak RoleService hiyerarşi kontrolü yapar (düşük position'daki rolleri yönetebilirsin).
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// RoleHandler, rol endpoint'lerini yöneten struct.
type RoleHandler struct {
	roleService services.RoleService
}

// NewRoleHandler, constructor.
func NewRoleHandler(roleService services.RoleService) *RoleHandler {
	return &RoleHandler{roleService: roleService}
}

// List godoc
// GET /api/servers/{serverId}/roles
// Tüm rolleri position DESC sıralı döner.
func (h *RoleHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	roles, err := h.roleService.GetAllByServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, roles)
}

// Create godoc
// POST /api/servers/{serverId}/roles
// Yeni rol oluşturur. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
func (h *RoleHandler) Create(w http.ResponseWriter, r *http.Request) {
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

	var req models.CreateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	role, err := h.roleService.Create(r.Context(), serverID, actor.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, role)
}

// Update godoc
// PATCH /api/servers/{serverId}/roles/{id}
// Rolü günceller. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
func (h *RoleHandler) Update(w http.ResponseWriter, r *http.Request) {
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

	roleID := r.PathValue("id")

	var req models.UpdateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	role, err := h.roleService.Update(r.Context(), serverID, actor.ID, roleID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, role)
}

// Delete godoc
// DELETE /api/servers/{serverId}/roles/{id}
// Rolü siler. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
func (h *RoleHandler) Delete(w http.ResponseWriter, r *http.Request) {
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

	roleID := r.PathValue("id")

	if err := h.roleService.Delete(r.Context(), serverID, actor.ID, roleID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "role deleted"})
}

// Reorder godoc
// PATCH /api/servers/{serverId}/roles/reorder
// Rollerin sıralamasını toplu olarak günceller. MANAGE_ROLES yetkisi gerektirir.
func (h *RoleHandler) Reorder(w http.ResponseWriter, r *http.Request) {
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

	var body struct {
		Items []models.PositionUpdate `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	roles, err := h.roleService.ReorderRoles(r.Context(), serverID, actor.ID, body.Items)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, roles)
}
