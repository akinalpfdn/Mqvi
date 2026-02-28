package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ReadStateHandler, okunmamış mesaj takibi endpoint'lerini yöneten struct.
type ReadStateHandler struct {
	readStateService services.ReadStateService
}

// NewReadStateHandler, constructor.
func NewReadStateHandler(readStateService services.ReadStateService) *ReadStateHandler {
	return &ReadStateHandler{readStateService: readStateService}
}

// markReadRequest, POST /api/servers/{serverId}/channels/{id}/read body'si.
type markReadRequest struct {
	MessageID string `json:"message_id"`
}

// MarkRead godoc
// POST /api/servers/{serverId}/channels/{id}/read
// Bir kanalı belirli bir mesaja kadar okunmuş olarak işaretler.
func (h *ReadStateHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req markReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.readStateService.MarkRead(r.Context(), user.ID, channelID, req.MessageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "marked as read"})
}

// GetUnreads godoc
// GET /api/servers/{serverId}/channels/unread
// Kullanıcının bu sunucudaki tüm kanallarındaki okunmamış mesaj sayılarını döner.
func (h *ReadStateHandler) GetUnreads(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	unreads, err := h.readStateService.GetUnreadCounts(r.Context(), user.ID, serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, unreads)
}
