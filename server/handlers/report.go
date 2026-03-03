// Package handlers — ReportHandler: kullanıcı raporlama endpoint'i.
//
// Endpoint:
//
//	POST /api/users/{userId}/report → Kullanıcıyı raporla
//
// Multipart/JSON dual support:
// - JSON body: sadece reason + description (dosya yok)
// - Multipart form: reason + description + opsiyonel dosyalar (delil resimleri)
//
// Dosya yükleme mesaj handler pattern'ı ile aynı:
// 1. Rapor oluştur (service layer)
// 2. Dosyaları yükle (upload service)
// 3. Attachments'ı response'a ekle
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
	service             services.ReportService
	reportUploadService services.ReportUploadService
	maxUploadSize       int64
}

// NewReportHandler, constructor.
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

// CreateReport godoc
// POST /api/users/{userId}/report
//
// JSON body: { "reason": "spam|...", "description": "..." }
// Multipart form: reason (field) + description (field) + files (opsiyonel, sadece resim)
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
		// Multipart: dosya + metin içeren rapor
		if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
			pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
			return
		}
		req.Reason = r.FormValue("reason")
		req.Description = r.FormValue("description")
	} else {
		// JSON: sadece metin rapor (dosya yok)
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

	// Null protection — JSON'da null yerine [] döner
	report.Attachments = []models.ReportAttachment{}

	// Dosya yükleme — rapor oluşturulduktan sonra (message handler pattern).
	// Dosyalar opsiyonel — yükleme hatası rapor oluşturmayı engellemez.
	if isMultipart(contentType) && r.MultipartForm != nil {
		files := r.MultipartForm.File["files"]
		for _, fileHeader := range files {
			file, err := fileHeader.Open()
			if err != nil {
				continue // Açılamayan dosyayı atla
			}

			att, err := h.reportUploadService.Upload(r.Context(), report.ID, file, fileHeader)
			file.Close()
			if err != nil {
				continue // Yüklenemeyen dosyayı atla (boyut/MIME hatası vb.)
			}

			report.Attachments = append(report.Attachments, *att)
		}
	}

	pkg.JSON(w, http.StatusCreated, report)
}
