// Package handlers — FriendshipHandler: arkadaşlık HTTP endpoint'leri.
//
// Thin handler prensibi: Parse → Service → Response.
// Tüm endpoint'ler auth middleware gerektirir (ek permission gerekmez).
//
// Route'lar (main.go'da bağlanır):
//
//	GET    /api/friends                    → ListFriends
//	GET    /api/friends/requests           → ListRequests (incoming + outgoing)
//	POST   /api/friends/requests           → SendRequest
//	POST   /api/friends/requests/{id}/accept → AcceptRequest
//	DELETE /api/friends/requests/{id}      → DeclineRequest
//	DELETE /api/friends/{userId}           → RemoveFriend
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// FriendshipHandler, arkadaşlık endpoint'lerini yöneten struct.
type FriendshipHandler struct {
	friendService services.FriendshipService
}

// NewFriendshipHandler, constructor.
func NewFriendshipHandler(friendService services.FriendshipService) *FriendshipHandler {
	return &FriendshipHandler{friendService: friendService}
}

// ListFriends godoc
// GET /api/friends
// Kullanıcının kabul edilmiş arkadaşlarını döner.
func (h *FriendshipHandler) ListFriends(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	friends, err := h.friendService.ListFriends(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, friends)
}

// ListRequests godoc
// GET /api/friends/requests
// Gelen ve gönderilen bekleyen istekleri döner.
// Response: { incoming: [...], outgoing: [...] }
func (h *FriendshipHandler) ListRequests(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	requests, err := h.friendService.ListRequests(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, requests)
}

// SendRequest godoc
// POST /api/friends/requests
// Body: { "username": "john" }
// Hedef kullanıcıya arkadaşlık isteği gönderir.
func (h *FriendshipHandler) SendRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.SendFriendRequestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	result, err := h.friendService.SendRequest(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, result)
}

// AcceptRequest godoc
// POST /api/friends/requests/{id}/accept
// Gelen arkadaşlık isteğini kabul eder.
func (h *FriendshipHandler) AcceptRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	requestID := r.PathValue("id")
	if requestID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "request id is required")
		return
	}

	result, err := h.friendService.AcceptRequest(r.Context(), user.ID, requestID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}

// DeclineRequest godoc
// DELETE /api/friends/requests/{id}
// Gelen isteği reddeder veya gönderilen isteği iptal eder.
func (h *FriendshipHandler) DeclineRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	requestID := r.PathValue("id")
	if requestID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "request id is required")
		return
	}

	if err := h.friendService.DeclineRequest(r.Context(), user.ID, requestID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "request declined"})
}

// RemoveFriend godoc
// DELETE /api/friends/{userId}
// Mevcut arkadaşlığı kaldırır.
func (h *FriendshipHandler) RemoveFriend(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetUserID := r.PathValue("userId")
	if targetUserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user id is required")
		return
	}

	if err := h.friendService.RemoveFriend(r.Context(), user.ID, targetUserID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "friend removed"})
}
