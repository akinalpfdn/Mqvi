package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type RoleHandler struct {
	roleService services.RoleService
}

func NewRoleHandler(roleService services.RoleService) *RoleHandler {
	return &RoleHandler{roleService: roleService}
}

// List handles GET /api/servers/{serverId}/roles
// Returns all roles ordered by position DESC.
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

// Create handles POST /api/servers/{serverId}/roles
// Requires MANAGE_ROLES + hierarchy check.
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

// Update handles PATCH /api/servers/{serverId}/roles/{id}
// Requires MANAGE_ROLES + hierarchy check.
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

// Delete handles DELETE /api/servers/{serverId}/roles/{id}
// Requires MANAGE_ROLES + hierarchy check.
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

// Reorder handles PATCH /api/servers/{serverId}/roles/reorder
// Requires MANAGE_ROLES.
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
