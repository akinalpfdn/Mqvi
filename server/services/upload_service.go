package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/files"
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
	locator        *files.Locator
	maxSize        int64
}

func NewUploadService(
	attachmentRepo repository.AttachmentRepository,
	locator *files.Locator,
	maxSize int64,
) UploadService {
	return &uploadService{
		attachmentRepo: attachmentRepo,
		locator:        locator,
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

	diskFilename, err := files.GenerateDiskFilename(header.Filename)
	if err != nil {
		return nil, err
	}

	relURL, err := s.locator.SaveFile(files.KindMessage, messageID, diskFilename, func(dst *os.File) error {
		if _, err := io.Copy(dst, file); err != nil {
			return fmt.Errorf("failed to save file: %w", err)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, files.ErrInvalidSegment) {
			return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		return nil, err
	}

	fileSize := header.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  header.Filename,
		FileURL:   relURL,
		FileSize:  &fileSize,
		MimeType:  &mimeBase,
	}

	if err := s.attachmentRepo.Create(ctx, attachment); err != nil {
		s.locator.DeleteFromURL(relURL)
		return nil, fmt.Errorf("failed to create attachment record: %w", err)
	}

	return attachment, nil
}
