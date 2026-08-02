package handlers

import (
	"context"
	"encoding/json"
	"log"
	"mime/multipart"
	"net/http"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/services"
)

const maxReportUploadFiles = 4

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
		limitMultipartBody(w, r, h.maxUploadSize, maxReportUploadFiles)
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}
		if len(r.MultipartForm.File["files"]) > maxReportUploadFiles {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "too many files")
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

		attachments, uploadedBytes := uploadBestEffort(
			r.Context(), files,
			func(ctx context.Context, file multipart.File, fh *multipart.FileHeader) (*models.ReportAttachment, error) {
				return h.reportUploadService.Upload(ctx, report.ID, file, fh)
			},
			func(a *models.ReportAttachment) int64 { return storedSize(a.FileSize, nil) },
			func(filename string, err error) {
				// %q, not %s: the filename comes from the client and a decoded filename* can carry a
				// newline, which would let a reporter forge whole log lines.
				log.Printf("[report] skipped evidence %q for report %s: %v", filename, report.ID, err)
			},
		)
		report.Attachments = append(report.Attachments, attachments...)

		releaseQuota(r.Context(), h.storageService, "report", user.ID, totalSize-uploadedBytes)
	}

	for i := range report.Attachments {
		report.Attachments[i].FileURL = h.urlSigner.SignURL(report.Attachments[i].FileURL)
	}
	pkg.JSON(w, http.StatusCreated, report)
}
