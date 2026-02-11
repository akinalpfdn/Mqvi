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

// UploadService, dosya yükleme iş mantığı interface'i.
type UploadService interface {
	Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader) (*models.Attachment, error)
}

type uploadService struct {
	attachmentRepo repository.AttachmentRepository
	uploadDir      string
	maxSize        int64
}

// NewUploadService, constructor.
func NewUploadService(
	attachmentRepo repository.AttachmentRepository,
	uploadDir string,
	maxSize int64,
) UploadService {
	return &uploadService{
		attachmentRepo: attachmentRepo,
		uploadDir:      uploadDir,
		maxSize:        maxSize,
	}
}

// allowedMimeTypes, yüklemeye izin verilen dosya türleri.
var allowedMimeTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/gif":       true,
	"image/webp":      true,
	"video/mp4":       true,
	"video/webm":      true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"application/pdf": true,
	"text/plain":      true,
}

// Upload, dosyayı doğrular, diske kaydeder ve DB'ye attachment kaydı oluşturur.
func (s *uploadService) Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader) (*models.Attachment, error) {
	// Boyut kontrolü
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	// MIME type kontrolü
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	// Sadece base MIME type'ı al (charset vb. parametre olabilir)
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	if !allowedMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: file type not allowed: %s", pkg.ErrBadRequest, mimeBase)
	}

	// Unique dosya adı oluştur — çakışma ve güvenlik için
	// {random_hex}_{original_filename} formatı
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
		// Hata durumunda dosyayı temizle
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to save file: %w", err)
	}

	// DB'ye attachment kaydı oluştur
	fileSize := header.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  header.Filename,
		FileURL:   "/api/uploads/" + diskFilename,
		FileSize:  &fileSize,
		MimeType:  &mimeBase,
	}

	if err := s.attachmentRepo.Create(ctx, attachment); err != nil {
		os.Remove(destPath) // Hata durumunda dosyayı temizle
		return nil, fmt.Errorf("failed to create attachment record: %w", err)
	}

	return attachment, nil
}

// sanitizeFilename, dosya adını güvenli hale getirir.
// Path traversal saldırılarını önler (../../etc/passwd gibi).
func sanitizeFilename(name string) string {
	// Sadece dosya adını al (dizin yolunu kaldır)
	name = filepath.Base(name)

	// Tehlikeli karakterleri kaldır
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1 // Karakteri sil
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
