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

// DMUploadService, DM dosya yükleme iş mantığı interface'i.
//
// Channel UploadService ile paralel yapı — aynı dosya doğrulama ve
// disk kaydetme mantığı, ancak DMAttachment modeli ve DMRepository kullanır.
type DMUploadService interface {
	Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader) (*models.DMAttachment, error)
}

type dmUploadService struct {
	dmRepo    repository.DMRepository
	uploadDir string
	maxSize   int64
}

// NewDMUploadService, constructor.
func NewDMUploadService(
	dmRepo repository.DMRepository,
	uploadDir string,
	maxSize int64,
) DMUploadService {
	return &dmUploadService{
		dmRepo:    dmRepo,
		uploadDir: uploadDir,
		maxSize:   maxSize,
	}
}

// Upload, DM dosyasını doğrular, diske kaydeder ve DB'ye DMAttachment kaydı oluşturur.
//
// UploadService.Upload ile aynı doğrulama ve kaydetme mantığı:
// 1. Boyut kontrolü (maxSize)
// 2. MIME type kontrolü (allowedMimeTypes — package-level, upload_service.go'da tanımlı)
// 3. Unique dosya adı oluşturma (randomhex_originalname)
// 4. Diske kaydetme
// 5. DB'ye DMAttachment kaydı oluşturma
func (s *dmUploadService) Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader) (*models.DMAttachment, error) {
	// Boyut kontrolü
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	// MIME type kontrolü — allowedMimeTypes upload_service.go'da tanımlı (aynı package)
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	if !allowedMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: file type not allowed: %s", pkg.ErrBadRequest, mimeBase)
	}

	// Unique dosya adı oluştur
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	// Dosyayı diske kaydet
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

	// DB'ye DMAttachment kaydı oluştur
	fileSize := header.Size
	attachment := &models.DMAttachment{
		DMMessageID: dmMessageID,
		Filename:    header.Filename,
		FileURL:     "/api/uploads/" + diskFilename,
		FileSize:    &fileSize,
		MimeType:    &mimeBase,
	}

	if err := s.dmRepo.CreateAttachment(ctx, attachment); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to create DM attachment record: %w", err)
	}

	return attachment, nil
}
