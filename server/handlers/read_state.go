package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// ReadStateHandler handles unread message tracking endpoints.
type ReadStateHandler struct {
	readStateService services.ReadStateService
	// Same bucket as the DM mark-read: same shape (a write plus reads on a four-connection pool
	// with an fsync per commit), same damage in a loop.
	readLimiter *ratelimit.MessageRateLimiter
}

func NewReadStateHandler(
	readStateService services.ReadStateService,
	readLimiter *ratelimit.MessageRateLimiter,
) *ReadStateHandler {
	return &ReadStateHandler{readStateService: readStateService, readLimiter: readLimiter}
}

type markReadRequest struct {
	MessageID string `json:"message_id"`
}

// MarkRead marks a channel as read up to a specific message.
// POST /api/servers/{serverId}/channels/{id}/read
func (h *ReadStateHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if rateLimited(w, h.readLimiter, user.ID) {
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

// MarkAllRead marks all channels in the server as read.
// POST /api/servers/{serverId}/channels/read-all
func (h *ReadStateHandler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if rateLimited(w, h.readLimiter, user.ID) {
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	if err := h.readStateService.MarkAllRead(r.Context(), user.ID, serverID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "all channels marked as read"})
}

type markMentionSeenRequest struct {
	MentionMessageID string `json:"mention_message_id"`
}

// MarkMentionSeen advances the mention-seen watermark for a channel.
// POST /api/servers/{serverId}/channels/{id}/read/mentions
func (h *ReadStateHandler) MarkMentionSeen(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if rateLimited(w, h.readLimiter, user.ID) {
		return
	}

	var req markMentionSeenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.readStateService.MarkMentionSeen(r.Context(), user.ID, channelID, req.MentionMessageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "mention seen"})
}

// GetUnreads returns unread message counts for all channels in the server.
// GET /api/servers/{serverId}/channels/unread
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
