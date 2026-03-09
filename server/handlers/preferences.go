package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// PreferencesHandler handles GET/PATCH /api/users/me/preferences.
type PreferencesHandler struct {
	svc services.PreferencesService
}

// NewPreferencesHandler creates a new PreferencesHandler.
func NewPreferencesHandler(svc services.PreferencesService) *PreferencesHandler {
	return &PreferencesHandler{svc: svc}
}

// Get returns the user's preferences JSON blob.
func (h *PreferencesHandler) Get(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	prefs, err := h.svc.Get(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, prefs)
}

// Update merges partial preferences into the user's existing preferences.
func (h *PreferencesHandler) Update(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdatePreferencesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	prefs, err := h.svc.Update(r.Context(), user.ID, req.Data)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, prefs)
}
