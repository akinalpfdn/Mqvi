// Package handlers — VoiceMessageHandler: ephemeral voice channel chat.
// Endpoints are membership-gated by VoiceMessageService (must be in the
// target voice channel). Attachments use the existing UploadPipeline with
// KindVoiceMsg so the channel-scoped directory can be wiped on cleanup.
package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ctxkeys"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

const maxVoiceMessageUploadFiles = 5

type VoiceMessageHandler struct {
	voiceMessageService services.VoiceMessageService
	pipeline            services.UploadPipeline
	urlSigner           services.FileURLSigner
	messageLimiter      *ratelimit.MessageRateLimiter
	maxUploadSize       int64
}

func NewVoiceMessageHandler(
	voiceMessageService services.VoiceMessageService,
	pipeline services.UploadPipeline,
	urlSigner services.FileURLSigner,
	messageLimiter *ratelimit.MessageRateLimiter,
	maxUploadSize int64,
) *VoiceMessageHandler {
	return &VoiceMessageHandler{
		voiceMessageService: voiceMessageService,
		pipeline:            pipeline,
		urlSigner:           urlSigner,
		messageLimiter:      messageLimiter,
		maxUploadSize:       maxUploadSize,
	}
}

// List handles GET /api/voice-channels/{channelId}/messages
func (h *VoiceMessageHandler) List(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	msgs, err := h.voiceMessageService.List(r.Context(), user.ID, channelID, 200)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, msgs)
}

// Create handles POST /api/voice-channels/{channelId}/messages
// Accepts JSON or multipart/form-data (for file attachments, field name "files").
func (h *VoiceMessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
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
	var req models.CreateVoiceMessageRequest

	if isMultipart(contentType) {
		limitMultipartBody(w, r, h.maxUploadSize, maxVoiceMessageUploadFiles)
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}
		if r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > maxVoiceMessageUploadFiles {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "too many files")
			return
		}
		req.Content = r.FormValue("content")
		if r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0 {
			req.HasFiles = true
		}
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	message, err := h.voiceMessageService.Create(r.Context(), user.ID, channelID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Upload attachments AFTER the message is created so we can scope files by message ID.
	// On any single upload failure we delete the message (best-effort), drop the request.
	if isMultipart(contentType) && r.MultipartForm != nil && len(r.MultipartForm.File["files"]) > 0 {
		for _, fh := range r.MultipartForm.File["files"] {
			f, err := fh.Open()
			if err != nil {
				continue
			}
			stored, storeErr := h.pipeline.Store(r.Context(), files.KindVoiceMsg, channelID, f, fh, h.maxUploadSize)
			f.Close()
			if storeErr != nil {
				_ = h.voiceMessageService.Delete(r.Context(), user.ID, message.ID)
				pkg.Error(w, storeErr)
				return
			}
			mime := fh.Header.Get("Content-Type")
			var mimePtr *string
			if mime != "" {
				mimePtr = &mime
			}
			att, attErr := h.voiceMessageService.AttachFile(r.Context(), message.ID, fh.Filename, stored.RelativeURL, fh.Size, mimePtr)
			if attErr != nil {
				_ = h.voiceMessageService.Delete(r.Context(), user.ID, message.ID)
				pkg.Error(w, attErr)
				return
			}
			att.FileURL = h.urlSigner.SignURL(att.FileURL)
			message.Attachments = append(message.Attachments, *att)
		}
	}

	h.voiceMessageService.BroadcastCreate(r.Context(), message)
	pkg.JSON(w, http.StatusCreated, message)
}

// Update handles PATCH /api/voice-channels/{channelId}/messages/{messageId}
func (h *VoiceMessageHandler) Update(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateVoiceMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	msg, err := h.voiceMessageService.Update(r.Context(), user.ID, messageID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, msg)
}

// Delete handles DELETE /api/voice-channels/{channelId}/messages/{messageId}
func (h *VoiceMessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	messageID := r.PathValue("messageId")
	user, ok := r.Context().Value(ctxkeys.User).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if err := h.voiceMessageService.Delete(r.Context(), user.ID, messageID); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
