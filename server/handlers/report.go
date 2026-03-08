package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

// ReportHandler handles user reporting.
// Supports both JSON (text only) and multipart (text + evidence files).
type ReportHandler struct {
	service             services.ReportService
	reportUploadService services.ReportUploadService
	maxUploadSize       int64
}

func NewReportHandler(
	service services.ReportService,
	reportUploadService services.ReportUploadService,
	maxUploadSize int64,
) *ReportHandler {
	return &ReportHandler{
		service:             service,
		reportUploadService: reportUploadService,
		maxUploadSize:       maxUploadSize,
	}
}

// CreateReport -- POST /api/users/{userId}/report
// JSON body: { "reason": "spam|...", "description": "..." }
// Multipart: reason + description fields + optional image files
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
	contentType := r.Header.Get("Content-Type")

	if isMultipart(contentType) {
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}
		req.Reason = r.FormValue("reason")
		req.Description = r.FormValue("description")
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}

	report, err := h.service.CreateReport(r.Context(), user.ID, targetID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	// Null protection -- return [] instead of null in JSON
	report.Attachments = []models.ReportAttachment{}

	// File uploads are optional -- upload failures don't block report creation
	if isMultipart(contentType) && r.MultipartForm != nil {
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue
			}

			att, err := h.reportUploadService.Upload(r.Context(), report.ID, file, fileHeader)
			file.Close()
			if err != nil {
				continue
			}

			report.Attachments = append(report.Attachments, *att)
		}
	}

	pkg.JSON(w, http.StatusCreated, report)
}
