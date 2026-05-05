package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

// DMHandler handles DM endpoints.
// messageLimiter is shared with MessageHandler (user-based total rate).
type DMHandler struct {
	dmService       services.DMService
	dmUploadService services.DMUploadService
	maxUploadSize   int64
	messageLimiter  *ratelimit.MessageRateLimiter
	urlSigner       services.FileURLSigner
}

func NewDMHandler(
	dmService services.DMService,
	dmUploadService services.DMUploadService,
	maxUploadSize int64,
	messageLimiter *ratelimit.MessageRateLimiter,
	urlSigner services.FileURLSigner,
) *DMHandler {
	return &DMHandler{
		dmService:       dmService,
		dmUploadService: dmUploadService,
		maxUploadSize:   maxUploadSize,
		messageLimiter:  messageLimiter,
		urlSigner:       urlSigner,
	}
}

type createDMChannelRequest struct {
	UserID string `json:"user_id"`
}

// ListChannels handles GET /api/dms
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

// CreateOrGetChannel handles POST /api/dms
// Finds or creates a DM channel between two users.
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

// AcceptRequest handles POST /api/dms/{channelId}/accept
func (h *DMHandler) AcceptRequest(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.AcceptRequest(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeclineRequest handles POST /api/dms/{channelId}/decline
func (h *DMHandler) DeclineRequest(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.DeclineRequest(r.Context(), user.ID, channelID); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetMessages handles GET /api/dms/{channelId}/messages?before=&limit=
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

// SendMessage handles POST /api/dms/{channelId}/messages
// Accepts JSON or multipart/form-data. Files uploaded after message creation, then WS broadcast.
func (h *DMHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.messageLimiter != nil && !h.messageLimiter.Allow(user.ID) {
		retryAfter := h.messageLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many messages, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	contentType := r.Header.Get("Content-Type")
	var req models.CreateDMMessageRequest

	if isMultipart(contentType) {
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}

		req.Content = r.FormValue("content")
		if replyTo := r.FormValue("reply_to_id"); replyTo != "" {
			req.ReplyToID = &replyTo
		}

		// E2EE fields from multipart
		if ev := r.FormValue("encryption_version"); ev == "1" {
			req.EncryptionVersion = 1
			if ct := r.FormValue("ciphertext"); ct != "" {
				req.Ciphertext = &ct
			}
			if sd := r.FormValue("sender_device_id"); sd != "" {
				req.SenderDeviceID = &sd
			}
			if em := r.FormValue("e2ee_metadata"); em != "" {
				req.E2EEMetadata = &em
			}
		}

		if r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0 {
			req.HasFiles = true
		}
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	msg, err := h.dmService.SendMessage(r.Context(), user.ID, channelID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	if isMultipart(contentType) && r.MultipartForm != nil {
		isEncrypted := req.EncryptionVersion == 1
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue
			}

			attachment, err := h.dmUploadService.Upload(r.Context(), msg.ID, file, fileHeader, isEncrypted)
			file.Close()
			if err != nil {
				continue
			}

			attachment.FileURL = h.urlSigner.SignURL(attachment.FileURL)
			msg.Attachments = append(msg.Attachments, *attachment)
		}
	}

	// Broadcast after uploads so clients see attachments
	h.dmService.BroadcastCreate(msg)

	pkg.JSON(w, http.StatusCreated, msg)
}

// EditMessage handles PATCH /api/dms/messages/{id} (owner only).
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

// DeleteMessage handles DELETE /api/dms/messages/{id} (owner only).
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

// ─── Reaction Endpoints ───

// ToggleReaction handles POST /api/dms/messages/{id}/reactions
func (h *DMHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.ToggleDMReactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := h.dmService.ToggleReaction(r.Context(), user.ID, messageID, req.Emoji); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ─── Pin Endpoints ───

// PinMessage handles POST /api/dms/messages/{id}/pin
func (h *DMHandler) PinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.PinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "pinned"})
}

// UnpinMessage handles DELETE /api/dms/messages/{id}/pin
func (h *DMHandler) UnpinMessage(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("id")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.dmService.UnpinMessage(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"status": "unpinned"})
}

// GetPinnedMessages handles GET /api/dms/{channelId}/pinned
func (h *DMHandler) GetPinnedMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	messages, err := h.dmService.GetPinnedMessages(r.Context(), user.ID, channelID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, messages)
}

// ─── Search Endpoint ───

// SearchMessages handles GET /api/dms/{channelId}/search?q=&limit=&offset=
// FTS5 full-text search within a DM channel.
func (h *DMHandler) SearchMessages(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.JSON(w, http.StatusOK, models.DMSearchResult{Messages: []models.DMMessage{}, TotalCount: 0})
		return
	}

	limit := 25
	offset := 0

	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	result, err := h.dmService.SearchMessages(r.Context(), user.ID, channelID, query, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}

// ToggleE2EE handles PATCH /api/dms/{channelId}/e2ee
// Enables or disables E2EE on a DM channel. Either participant can toggle.
func (h *DMHandler) ToggleE2EE(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	channel, err := h.dmService.ToggleE2EE(r.Context(), user.ID, channelID, req.Enabled)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, channel)
}
