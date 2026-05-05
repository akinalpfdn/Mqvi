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

// MessageHandler handles message endpoints.
// messageLimiter is shared with DMHandler (user-based, controls total message rate).
type MessageHandler struct {
	messageService services.MessageService
	uploadService  services.UploadService
	maxUploadSize  int64
	messageLimiter *ratelimit.MessageRateLimiter
	urlSigner      services.FileURLSigner
}

func NewMessageHandler(
	messageService services.MessageService,
	uploadService services.UploadService,
	maxUploadSize int64,
	messageLimiter *ratelimit.MessageRateLimiter,
	urlSigner services.FileURLSigner,
) *MessageHandler {
	return &MessageHandler{
		messageService: messageService,
		uploadService:  uploadService,
		maxUploadSize:  maxUploadSize,
		messageLimiter: messageLimiter,
		urlSigner:      urlSigner,
	}
}

// List handles GET /api/channels/{id}/messages?before=ID&limit=50
// Cursor-based pagination: before=messageID for older messages, limit max 100.
func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	beforeID := r.URL.Query().Get("before")

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	page, err := h.messageService.GetByChannelID(r.Context(), channelID, user.ID, beforeID, limit)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, page)
}

// Create handles POST /api/channels/{id}/messages
// Accepts JSON or multipart/form-data (for file attachments).
func (h *MessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")

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

	var req models.CreateMessageRequest

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

	message, err := h.messageService.Create(r.Context(), channelID, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Upload files after message creation
	if isMultipart(contentType) && r.MultipartForm != nil {
		isEncrypted := req.EncryptionVersion == 1
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue
			}

			attachment, err := h.uploadService.Upload(r.Context(), message.ID, file, fileHeader, isEncrypted)
			file.Close()
			if err != nil {
				continue
			}

			attachment.FileURL = h.urlSigner.SignURL(attachment.FileURL)
			message.Attachments = append(message.Attachments, *attachment)
		}
	}

	// Set transient server_id so clients can route cross-server notifications
	message.ServerID = r.PathValue("serverId")

	// Broadcast after uploads so all clients see attachments
	h.messageService.BroadcastCreate(message)

	pkg.JSON(w, http.StatusCreated, message)
}

// Update handles PATCH /api/messages/{id} (owner only).
func (h *MessageHandler) Update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	message, err := h.messageService.Update(r.Context(), id, user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, message)
}

// Delete handles DELETE /api/messages/{id} (owner or MANAGE_MESSAGES permission).
func (h *MessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perms, _ := r.Context().Value(PermissionsContextKey).(models.Permission)

	if err := h.messageService.Delete(r.Context(), id, user.ID, perms); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "message deleted"})
}

// Upload handles POST /api/upload (standalone file upload).
func (h *MessageHandler) Upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	messageID := r.FormValue("message_id")

	isEncrypted := r.FormValue("encryption_version") == "1"
	attachment, err := h.uploadService.Upload(r.Context(), messageID, file, header, isEncrypted)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	attachment.FileURL = h.urlSigner.SignURL(attachment.FileURL)
	pkg.JSON(w, http.StatusCreated, attachment)
}

// PermissionsContextKey carries the user's effective permissions in request context.
const PermissionsContextKey contextKey = "permissions"

func isMultipart(contentType string) bool {
	return len(contentType) >= 19 && contentType[:19] == "multipart/form-data"
}
