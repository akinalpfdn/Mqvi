// Package handlers — ReportHandler: kullanıcı raporlama endpoint'i.
//
// Endpoint:
//   POST /api/users/{userId}/report → Kullanıcıyı raporla
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ReportHandler, kullanıcı raporlama endpoint'ini yöneten struct.
type ReportHandler struct {
	service services.ReportService
}

// NewReportHandler, constructor.
func NewReportHandler(service services.ReportService) *ReportHandler {
	return &ReportHandler{service: service}
}

// CreateReport godoc
// POST /api/users/{userId}/report
// Body: { "reason": "spam|harassment|inappropriate_content|impersonation|other", "description": "..." }
func (h *ReportHandler) CreateReport(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	targetID := r.PathValue("userId")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "userId is required")
		return
	}

	var req models.CreateReportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	report, err := h.service.CreateReport(r.Context(), user.ID, targetID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, report)
}
