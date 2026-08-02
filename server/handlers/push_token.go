package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/services"
)

// PushTokenHandler handles push notification token registration endpoints.
type PushTokenHandler struct {
	pushTokenService services.PushTokenService
}

func NewPushTokenHandler(pushTokenService services.PushTokenService) *PushTokenHandler {
	return &PushTokenHandler{pushTokenService: pushTokenService}
}

// Register stores or refreshes the caller's push token.
// POST /api/push/tokens
func (h *PushTokenHandler) Register(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req models.RegisterPushTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, err := h.pushTokenService.RegisterToken(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, token)
}

// Unregister removes a push token (called on logout or when notifications are disabled).
// DELETE /api/push/tokens
func (h *PushTokenHandler) Unregister(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.pushTokenService.UnregisterToken(r.Context(), user.ID, req.Token); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}
