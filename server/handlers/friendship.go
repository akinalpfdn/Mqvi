package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type FriendshipHandler struct {
	friendService services.FriendshipService
}

func NewFriendshipHandler(friendService services.FriendshipService) *FriendshipHandler {
	return &FriendshipHandler{friendService: friendService}
}

// ListFriends handles GET /api/friends
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

// ListRequests handles GET /api/friends/requests
// Returns both incoming and outgoing pending requests.
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

// SendRequest handles POST /api/friends/requests
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

// AcceptRequest handles POST /api/friends/requests/{id}/accept
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

// DeclineRequest handles DELETE /api/friends/requests/{id}
// Declines an incoming request or cancels an outgoing one.
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

// RemoveFriend handles DELETE /api/friends/{userId}
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
