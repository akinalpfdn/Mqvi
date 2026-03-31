package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

type FeedbackHandler struct {
	service services.FeedbackService
}

func NewFeedbackHandler(service services.FeedbackService) *FeedbackHandler {
	return &FeedbackHandler{service: service}
}

// CreateTicket -- POST /api/feedback
func (h *FeedbackHandler) CreateTicket(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateFeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	ticket, err := h.service.CreateTicket(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

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

	pkg.JSON(w, http.StatusOK, map[string]any{
		"ticket":  ticket,
		"replies": replies,
	})
}

// AddReply -- POST /api/feedback/{id}/reply
func (h *FeedbackHandler) AddReply(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	ticketID := r.PathValue("id")

	var req models.CreateFeedbackReplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	reply, err := h.service.AddReply(r.Context(), ticketID, user.ID, false, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, reply)
}

// ─── Admin Endpoints ───

// AdminListTickets -- GET /api/admin/feedback?status=open&type=bug&limit=50&offset=0
func (h *FeedbackHandler) AdminListTickets(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	ticketType := r.URL.Query().Get("type")
	limit, offset := parsePagination(r)

	tickets, total, err := h.service.ListAll(r.Context(), status, ticketType, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"tickets": tickets,
		"total":   total,
	})
}

// AdminGetTicket -- GET /api/admin/feedback/{id}
func (h *FeedbackHandler) AdminGetTicket(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	ticket, replies, err := h.service.GetTicketByID(r.Context(), id, "", true)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"ticket":  ticket,
		"replies": replies,
	})
}

// AdminReply -- POST /api/admin/feedback/{id}/reply
func (h *FeedbackHandler) AdminReply(w http.ResponseWriter, r *http.Request) {
	admin, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "admin not found in context")
		return
	}
	ticketID := r.PathValue("id")

	var req models.CreateFeedbackReplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	reply, err := h.service.AddReply(r.Context(), ticketID, admin.ID, true, &req)
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
