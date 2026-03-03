// Package services — ReportUploadService: rapor delili dosya yükleme.
//
// DM/Channel UploadService ile paralel yapı — sadece resim dosyaları kabul eder.
// Dosyalar aynı upload dizinine kaydedilir, aynı /api/uploads/ endpoint'i üzerinden servis edilir.
//
// Rapor delilleri için sadece image/jpeg, image/png, image/gif, image/webp kabul edilir.
// Video, audio, pdf gibi dosyalar reddedilir — delil olarak ekran görüntüsü yeterlidir.
package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// ReportUploadService, rapor delili dosya yükleme iş mantığı interface'i.
type ReportUploadService interface {
	Upload(ctx context.Context, reportID string, file multipart.File, header *multipart.FileHeader) (*models.ReportAttachment, error)
}

type reportUploadService struct {
	reportRepo repository.ReportRepository
	uploadDir  string
	maxSize    int64
}

// NewReportUploadService, constructor.
func NewReportUploadService(
	reportRepo repository.ReportRepository,
	uploadDir string,
	maxSize int64,
) ReportUploadService {
	return &reportUploadService{
		reportRepo: reportRepo,
		uploadDir:  uploadDir,
		maxSize:    maxSize,
	}
}

// allowedReportMimeTypes, rapor delili olarak kabul edilen dosya türleri.
// Sadece resimler — ekran görüntüsü delili için yeterli.
var allowedReportMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// Upload, rapor delil dosyasını doğrular, diske kaydeder ve DB'ye kaydı oluşturur.
//
// Validation zinciri:
// 1. Boyut kontrolü (maxSize)
// 2. MIME type kontrolü (sadece image/*)
// 3. Unique dosya adı oluşturma
// 4. Diske kaydetme
// 5. DB kaydı (report_attachments)
func (s *reportUploadService) Upload(ctx context.Context, reportID string, file multipart.File, header *multipart.FileHeader) (*models.ReportAttachment, error) {
	// 1. Boyut kontrolü
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	// 2. MIME type kontrolü — sadece resimler kabul edilir
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	if !allowedReportMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: only images are allowed for report evidence (got: %s)", pkg.ErrBadRequest, mimeBase)
	}

	// 3. Unique dosya adı oluştur — sanitizeFilename upload_service.go'da tanımlı (aynı package)
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	// 4. Dosyayı diske kaydet
	destPath := filepath.Join(s.uploadDir, diskFilename)
	destFile, err := os.Create(destPath)
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to save file: %w", err)
	}

	// 5. DB'ye report_attachment kaydı oluştur
	fileSize := header.Size
	att := &models.ReportAttachment{
		ReportID: reportID,
		Filename: header.Filename,
		FileURL:  "/api/uploads/" + diskFilename,
		FileSize: &fileSize,
		MimeType: &mimeBase,
	}

	if err := s.reportRepo.CreateAttachment(ctx, att); err != nil {
		os.Remove(destPath) // DB hatası durumunda dosyayı temizle
		return nil, fmt.Errorf("failed to create report attachment record: %w", err)
	}

	return att, nil
}
