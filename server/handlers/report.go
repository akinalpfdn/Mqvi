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
	storageService      services.StorageService
	maxUploadSize       int64
	urlSigner           services.FileURLSigner
}

func NewReportHandler(
	service services.ReportService,
	reportUploadService services.ReportUploadService,
	storageService services.StorageService,
	maxUploadSize int64,
	urlSigner services.FileURLSigner,
) *ReportHandler {
	return &ReportHandler{
		service:             service,
		reportUploadService: reportUploadService,
		storageService:      storageService,
		maxUploadSize:       maxUploadSize,
		urlSigner:           urlSigner,
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

		var totalSize int64
		for _, fh := range files {
			totalSize += fh.Size
		}
		if totalSize > 0 {
			if err := h.storageService.Reserve(r.Context(), user.ID, totalSize); err != nil {
				// Quota exceeded — still return the report, just without attachments
				for i := range report.Attachments {
					report.Attachments[i].FileURL = h.urlSigner.SignURL(report.Attachments[i].FileURL)
				}
				pkg.JSON(w, http.StatusCreated, report)
				return
			}
		}

		var uploadedBytes int64
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

			uploadedBytes += fileHeader.Size
			report.Attachments = append(report.Attachments, *att)
		}

		if unused := totalSize - uploadedBytes; unused > 0 {
			_ = h.storageService.Release(r.Context(), user.ID, unused)
		}
	}

	for i := range report.Attachments {
		report.Attachments[i].FileURL = h.urlSigner.SignURL(report.Attachments[i].FileURL)
	}
	pkg.JSON(w, http.StatusCreated, report)
}
