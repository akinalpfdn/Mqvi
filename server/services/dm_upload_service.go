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

// DMUploadService handles DM file uploads. Parallel to UploadService for channel messages.
type DMUploadService interface {
	Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.DMAttachment, error)
}

type dmUploadService struct {
	dmRepo  repository.DMRepository
	locator *files.Locator
	maxSize int64
}

func NewDMUploadService(
	dmRepo repository.DMRepository,
	locator *files.Locator,
	maxSize int64,
) DMUploadService {
	return &dmUploadService{
		dmRepo:  dmRepo,
		locator: locator,
		maxSize: maxSize,
	}
}

func (s *dmUploadService) Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.DMAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)

	// No upload-time MIME restriction — serve-time handles XSS prevention.
	_ = isEncrypted

	diskFilename, err := files.GenerateDiskFilename(header.Filename)
	if err != nil {
		return nil, err
	}

	relURL, err := s.locator.SaveFile(files.KindDM, dmMessageID, diskFilename, func(dst *os.File) error {
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
	attachment := &models.DMAttachment{
		DMMessageID: dmMessageID,
		Filename:    header.Filename,
		FileURL:     relURL,
		FileSize:    &fileSize,
		MimeType:    &mimeBase,
	}

	if err := s.dmRepo.CreateAttachment(ctx, attachment); err != nil {
		s.locator.DeleteFromURL(relURL)
		return nil, fmt.Errorf("failed to create DM attachment record: %w", err)
	}

	return attachment, nil
}
