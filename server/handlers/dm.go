package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// DMHandler, DM (Direct Messages) endpoint'lerini yöneten struct.
type DMHandler struct {
	dmService services.DMService
}

// NewDMHandler, constructor.
func NewDMHandler(dmService services.DMService) *DMHandler {
	return &DMHandler{dmService: dmService}
}

// createDMChannelRequest, POST /api/dms body'si.
type createDMChannelRequest struct {
	UserID string `json:"user_id"`
}

// ListChannels godoc
// GET /api/dms
// Kullanıcının tüm DM kanallarını listeler (karşı taraf bilgisiyle).
func (h *DMHandler) ListChannels(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	channels, err := h.dmService.ListChannels(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channels)
}

// CreateOrGetChannel godoc
// POST /api/dms
// İki kullanıcı arasındaki DM kanalını bul veya oluştur.
//
// Body: { "user_id": "target_user_id" }
// Response: DMChannelWithUser (karşı taraf bilgisiyle)
func (h *DMHandler) CreateOrGetChannel(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req createDMChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.UserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	channel, err := h.dmService.GetOrCreateChannel(r.Context(), user.ID, req.UserID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}

// GetMessages godoc
// GET /api/dms/{channelId}/messages?before=&limit=
// DM kanalının mesajlarını cursor-based pagination ile döner.
func (h *DMHandler) GetMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	beforeID := r.URL.Query().Get("before")
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	page, err := h.dmService.GetMessages(r.Context(), user.ID, channelID, beforeID, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// SendMessage godoc
// POST /api/dms/{channelId}/messages
// Yeni bir DM mesajı gönderir.
//
// Body: { "content": "mesaj metni" }
func (h *DMHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateDMMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	msg, err := h.dmService.SendMessage(r.Context(), user.ID, channelID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, msg)
}

// EditMessage godoc
// PATCH /api/dms/messages/{id}
// DM mesajını düzenler (sadece mesaj sahibi).
func (h *DMHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateDMMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	msg, err := h.dmService.EditMessage(r.Context(), user.ID, messageID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, msg)
}

// DeleteMessage godoc
// DELETE /api/dms/messages/{id}
// DM mesajını siler (sadece mesaj sahibi).
func (h *DMHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.DeleteMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}
