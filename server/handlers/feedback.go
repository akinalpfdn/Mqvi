package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/ratelimit"
	"github.com/akinalp/mqvi/services"
)

const maxFeedbackUploadFiles = 4

type FeedbackHandler struct {
	service        services.FeedbackService
	uploadService  services.FeedbackUploadService
	storageService services.StorageService
	badgeService   services.SettingsBadgeService
	maxUploadSize  int64
	limiter        *ratelimit.MessageRateLimiter
	appLog         services.AppLogService
	urlSigner      services.FileURLSigner
}

func NewFeedbackHandler(service services.FeedbackService, uploadService services.FeedbackUploadService, storageService services.StorageService, badgeService services.SettingsBadgeService, maxUploadSize int64, limiter *ratelimit.MessageRateLimiter, appLog services.AppLogService, urlSigner services.FileURLSigner) *FeedbackHandler {
	return &FeedbackHandler{service: service, uploadService: uploadService, storageService: storageService, badgeService: badgeService, maxUploadSize: maxUploadSize, limiter: limiter, appLog: appLog, urlSigner: urlSigner}
}

// GetMyBadge -- GET /api/feedback/badge
func (h *FeedbackHandler) GetMyBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	hasNew, err := h.badgeService.GetUserFeedbackBadge(r.Context(), user)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]bool{"has_new_replies": hasNew})
}

// MarkMySeen -- POST /api/feedback/mark-seen
func (h *FeedbackHandler) MarkMySeen(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if err := h.badgeService.MarkFeedbackSeen(r.Context(), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CreateTicket -- POST /api/feedback
// Accepts JSON or multipart/form-data (with optional files[]).
func (h *FeedbackHandler) CreateTicket(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.limiter != nil && !h.limiter.Allow(user.ID) {
		retryAfter := h.limiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many feedback submissions, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	var req models.CreateFeedbackRequest
	contentType := r.Header.Get("Content-Type")

	if strings.HasPrefix(contentType, "multipart/") {
		limitMultipartBody(w, r, h.maxUploadSize, maxFeedbackUploadFiles)
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid multipart form")
			return
		}
		if len(r.MultipartForm.File["files"]) > maxFeedbackUploadFiles {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "too many files")
			return
		}
		req.Type = r.FormValue("type")
		req.Subject = r.FormValue("subject")
		req.Content = r.FormValue("content")
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	ticket, err := h.service.CreateTicket(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Handle file uploads (optional, failures don't block ticket creation)
	if r.MultipartForm != nil && r.MultipartForm.File["files"] != nil {
		fileHeaders := r.MultipartForm.File["files"]
		var totalSize int64
		for _, fh := range fileHeaders {
			totalSize += fh.Size
		}
		quotaOK := true
		if totalSize > 0 {
			if qErr := h.storageService.Reserve(r.Context(), user.ID, totalSize); qErr != nil {
				quotaOK = false
			}
		}
		if quotaOK {
			var uploadedBytes int64
			for _, fh := range fileHeaders {
				f, openErr := fh.Open()
				if openErr != nil {
					h.appLog.Log(models.LogLevelError, models.LogCategoryFeedback, &user.ID, nil,
						fmt.Sprintf("failed to open uploaded file %s: %v", fh.Filename, openErr), nil)
					continue
				}
				att, uploadErr := h.uploadService.Upload(r.Context(), ticket.ID, nil, f, fh)
				f.Close()
				if uploadErr != nil {
					h.appLog.Log(models.LogLevelError, models.LogCategoryFeedback, &user.ID, nil,
						fmt.Sprintf("failed to upload file %s for ticket %s: %v", fh.Filename, ticket.ID, uploadErr), nil)
					continue
				}
				if att.FileSize != nil {
					uploadedBytes += *att.FileSize
				}
				ticket.Attachments = append(ticket.Attachments, *att)
			}
			if unused := totalSize - uploadedBytes; unused > 0 {
				_ = h.storageService.Release(r.Context(), user.ID, unused)
			}
		}
	}

	h.signFeedbackAttachments(ticket.Attachments)
	pkg.JSON(w, http.StatusCreated, ticket)
}

// ListMyTickets -- GET /api/feedback?limit=20&offset=0
func (h *FeedbackHandler) ListMyTickets(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	limit, offset := parsePagination(r)

	tickets, total, err := h.service.ListByUser(r.Context(), user.ID, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	for i := range tickets {
		h.signFeedbackAttachments(tickets[i].Attachments)
	}
	pkg.JSON(w, http.StatusOK, map[string]any{
		"tickets": tickets,
		"total":   total,
	})
}

// GetTicket -- GET /api/feedback/{id}
func (h *FeedbackHandler) GetTicket(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	id := r.PathValue("id")

	ticket, replies, err := h.service.GetTicketByID(r.Context(), id, user.ID, false)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.signFeedbackAttachments(ticket.Attachments)
	for i := range replies {
		h.signFeedbackAttachments(replies[i].Attachments)
	}
	pkg.JSON(w, http.StatusOK, map[string]any{
		"ticket":  ticket,
		"replies": replies,
	})
}

// AddReply -- POST /api/feedback/{id}/reply
// Accepts JSON or multipart/form-data (with optional files[]).
func (h *FeedbackHandler) AddReply(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.limiter != nil && !h.limiter.Allow(user.ID) {
		retryAfter := h.limiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many replies, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	ticketID := r.PathValue("id")
	reply, err := h.parseAndCreateReply(w, r, ticketID, user.ID, false)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, reply)
}

// DeleteTicket -- DELETE /api/feedback/{id}
func (h *FeedbackHandler) DeleteTicket(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := h.service.DeleteTicket(r.Context(), r.PathValue("id"), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "feedback deleted"})
}

// ─── Admin Endpoints ───

// AdminListTickets -- GET /api/admin/feedback?status=open&status=closed&type=bug&sort=updated_at&dir=desc
// status and type are repeatable (or comma-separated) for multi-select filtering.
func (h *FeedbackHandler) AdminListTickets(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "admin not found in context")
		return
	}
	statuses := parseMultiQuery(r, "status")
	types := parseMultiQuery(r, "type")
	sortKey := r.URL.Query().Get("sort")
	sortDir := r.URL.Query().Get("dir")
	limit, offset := parsePagination(r)

	tickets, total, err := h.service.ListAllForAdmin(r.Context(), statuses, types, sortKey, sortDir, admin.ID, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	for i := range tickets {
		h.signFeedbackAttachments(tickets[i].Attachments)
	}
	pkg.JSON(w, http.StatusOK, map[string]any{
		"tickets": tickets,
		"total":   total,
	})
}

// AdminGetTicket -- GET /api/admin/feedback/{id}
func (h *FeedbackHandler) AdminGetTicket(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "admin not found in context")
		return
	}
	id := r.PathValue("id")

	// Passing the admin ID (isAdmin=true) clears this ticket's per-admin unread dot.
	ticket, replies, err := h.service.GetTicketByID(r.Context(), id, admin.ID, true)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.signFeedbackAttachments(ticket.Attachments)
	for i := range replies {
		h.signFeedbackAttachments(replies[i].Attachments)
	}
	pkg.JSON(w, http.StatusOK, map[string]any{
		"ticket":  ticket,
		"replies": replies,
	})
}

// AdminReply -- POST /api/admin/feedback/{id}/reply
// Accepts JSON or multipart/form-data (with optional files[]).
func (h *FeedbackHandler) AdminReply(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "admin not found in context")
		return
	}
	ticketID := r.PathValue("id")

	reply, err := h.parseAndCreateReply(w, r, ticketID, admin.ID, true)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, reply)
}

// AdminUpdateStatus -- PATCH /api/admin/feedback/{id}/status
func (h *FeedbackHandler) AdminUpdateStatus(w http.ResponseWriter, r *http.Request) {
	ticketID := r.PathValue("id")

	var req models.UpdateFeedbackStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.service.UpdateStatus(r.Context(), ticketID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "feedback status updated"})
}

// parseAndCreateReply handles both JSON and multipart reply creation with optional file uploads.
func (h *FeedbackHandler) parseAndCreateReply(w http.ResponseWriter, r *http.Request, ticketID, userID string, isAdmin bool) (*models.FeedbackReply, error) {
	var req models.CreateFeedbackReplyRequest
	contentType := r.Header.Get("Content-Type")

	if strings.HasPrefix(contentType, "multipart/") {
		limitMultipartBody(w, r, h.maxUploadSize, maxFeedbackUploadFiles)
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			return nil, fmt.Errorf("%w: invalid multipart form", pkg.ErrBadRequest)
		}
		if len(r.MultipartForm.File["files"]) > maxFeedbackUploadFiles {
			return nil, fmt.Errorf("%w: too many files", pkg.ErrBadRequest)
		}
		req.Content = r.FormValue("content")
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return nil, fmt.Errorf("%w: invalid request body", pkg.ErrBadRequest)
		}
	}

	reply, err := h.service.AddReply(r.Context(), ticketID, userID, isAdmin, &req)
	if err != nil {
		return nil, err
	}

	// Handle file uploads
	if r.MultipartForm != nil && r.MultipartForm.File["files"] != nil {
		fileHeaders := r.MultipartForm.File["files"]
		var totalSize int64
		for _, fh := range fileHeaders {
			totalSize += fh.Size
		}
		quotaOK := true
		if totalSize > 0 {
			if qErr := h.storageService.Reserve(r.Context(), userID, totalSize); qErr != nil {
				quotaOK = false
			}
		}
		if quotaOK {
			var uploadedBytes int64
			for _, fh := range fileHeaders {
				f, openErr := fh.Open()
				if openErr != nil {
					h.appLog.Log(models.LogLevelError, models.LogCategoryFeedback, &userID, nil,
						fmt.Sprintf("failed to open reply attachment %s: %v", fh.Filename, openErr), nil)
					continue
				}
				att, uploadErr := h.uploadService.Upload(r.Context(), ticketID, &reply.ID, f, fh)
				f.Close()
				if uploadErr != nil {
					h.appLog.Log(models.LogLevelError, models.LogCategoryFeedback, &userID, nil,
						fmt.Sprintf("failed to upload reply attachment %s: %v", fh.Filename, uploadErr), nil)
					continue
				}
				if att.FileSize != nil {
					uploadedBytes += *att.FileSize
				}
				reply.Attachments = append(reply.Attachments, *att)
			}
			if unused := totalSize - uploadedBytes; unused > 0 {
				_ = h.storageService.Release(r.Context(), userID, unused)
			}
		}
	}

	h.signFeedbackAttachments(reply.Attachments)
	return reply, nil
}

func (h *FeedbackHandler) signFeedbackAttachments(atts []models.FeedbackAttachment) {
	for i := range atts {
		atts[i].FileURL = h.urlSigner.SignURL(atts[i].FileURL)
	}
}

// parseMultiQuery collects a repeatable query param, also splitting comma-separated
// values (?status=open&status=closed or ?status=open,closed) into trimmed tokens.
func parseMultiQuery(r *http.Request, key string) []string {
	var out []string
	for _, raw := range r.URL.Query()[key] {
		for _, part := range strings.Split(raw, ",") {
			if v := strings.TrimSpace(part); v != "" {
				out = append(out, v)
			}
		}
	}
	return out
}

func parsePagination(r *http.Request) (limit, offset int) {
	limit = 20
	offset = 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	return
}
