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

// UploadService handles file upload validation, storage, and DB record creation.
// isEncrypted: E2EE files are client-side AES-256-GCM encrypted, sent as
// application/octet-stream — MIME whitelist is skipped for these.
type UploadService interface {
	Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.Attachment, error)
}

type uploadService struct {
	attachmentRepo repository.AttachmentRepository
	uploadDir      string
	maxSize        int64
}

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

func (s *uploadService) Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.Attachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	// Skip MIME whitelist for E2EE files (opaque blobs on server)
	if !isEncrypted && !allowedMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: file type not allowed: %s", pkg.ErrBadRequest, mimeBase)
	}

	// Generate unique filename: {random_hex}_{original_filename}
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

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

	fileSize := header.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  header.Filename,
		FileURL:   "/api/uploads/" + diskFilename,
		FileSize:  &fileSize,
		MimeType:  &mimeBase,
	}

	if err := s.attachmentRepo.Create(ctx, attachment); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to create attachment record: %w", err)
	}

	return attachment, nil
}

// sanitizeFilename strips path components and dangerous characters to prevent path traversal.
func sanitizeFilename(name string) string {
	name = filepath.Base(name)

	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
