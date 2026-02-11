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
// GET /api/roles
// Tüm rolleri position DESC sıralı döner.
func (h *RoleHandler) List(w http.ResponseWriter, r *http.Request) {
	roles, err := h.roleService.GetAll(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, roles)
}

// Create godoc
// POST /api/roles
// Body: { "name": "...", "color": "#FF5733", "permissions": 123 }
//
// Yeni rol oluşturur. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
// Position otomatik atanır (actor'un hemen altı).
func (h *RoleHandler) Create(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	role, err := h.roleService.Create(r.Context(), actor.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, role)
}

// Update godoc
// PATCH /api/roles/{id}
// Body: { "name": "...", "color": "...", "permissions": 123 } (partial update)
//
// Rolü günceller. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
func (h *RoleHandler) Update(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	roleID := r.PathValue("id")

	var req models.UpdateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	role, err := h.roleService.Update(r.Context(), actor.ID, roleID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, role)
}

// Delete godoc
// DELETE /api/roles/{id}
// Rolü siler. MANAGE_ROLES yetkisi + hiyerarşi kontrolü gerektirir.
// Default rol silinemez.
func (h *RoleHandler) Delete(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	roleID := r.PathValue("id")

	if err := h.roleService.Delete(r.Context(), actor.ID, roleID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "role deleted"})
}
