package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// CategoryHandler, kategori endpoint'lerini yöneten struct.
type CategoryHandler struct {
	categoryService services.CategoryService
}

// NewCategoryHandler, constructor.
func NewCategoryHandler(categoryService services.CategoryService) *CategoryHandler {
	return &CategoryHandler{categoryService: categoryService}
}

// List godoc
// GET /api/servers/{serverId}/categories
func (h *CategoryHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	categories, err := h.categoryService.GetAllByServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, categories)
}

// Create godoc
// POST /api/servers/{serverId}/categories
func (h *CategoryHandler) Create(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	var req models.CreateCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	category, err := h.categoryService.Create(r.Context(), serverID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, category)
}

// Update godoc
// PATCH /api/servers/{serverId}/categories/{id}
func (h *CategoryHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req models.UpdateCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	category, err := h.categoryService.Update(r.Context(), id, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, category)
}

// Delete godoc
// DELETE /api/servers/{serverId}/categories/{id}
func (h *CategoryHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	if err := h.categoryService.Delete(r.Context(), id); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "category deleted"})
}
