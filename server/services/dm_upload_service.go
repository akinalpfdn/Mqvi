package services

import (
	"context"
	"fmt"
	"mime/multipart"
	"strings"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/pkg/files"
	"github.com/akinalp/mqvi/repository"
)

// DMUploadService handles DM file uploads. Parallel to UploadService for channel messages.
type DMUploadService interface {
	Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool, thumb *ThumbnailUpload) (*models.DMAttachment, error)
}

type dmUploadService struct {
	dmRepo   repository.DMRepository
	pipeline UploadPipeline
	maxSize  int64
}

func NewDMUploadService(
	dmRepo repository.DMRepository,
	pipeline UploadPipeline,
	maxSize int64,
) DMUploadService {
	return &dmUploadService{
		dmRepo:   dmRepo,
		pipeline: pipeline,
		maxSize:  maxSize,
	}
}

func (s *dmUploadService) Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool, thumb *ThumbnailUpload) (*models.DMAttachment, error) {
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

	stored, err := s.pipeline.Store(ctx, files.KindDM, dmMessageID, file, header, s.maxSize)
	if err != nil {
		return nil, err
	}

	fileSize := stored.Size
	attachment := &models.DMAttachment{
		DMMessageID: dmMessageID,
		Filename:    header.Filename,
		FileURL:     stored.RelativeURL,
		FileSize:    &fileSize,
		MimeType:    &mimeBase,
	}
	if t := storeThumbnail(ctx, s.pipeline, files.KindDM, dmMessageID, thumb); t != nil {
		attachment.ThumbURL, attachment.ThumbWidth, attachment.ThumbHeight = &t.URL, t.Width, t.Height
		attachment.ThumbSize = &t.Size
	}

	if err := s.dmRepo.CreateAttachment(ctx, attachment); err != nil {
		s.pipeline.DeleteFromURL(stored.RelativeURL)
		// Same reason as the channel path: an orphaned thumbnail has no row and no cleanup query
		// that can ever find it.
		if attachment.ThumbURL != nil {
			s.pipeline.DeleteFromURL(*attachment.ThumbURL)
		}
		return nil, fmt.Errorf("failed to create DM attachment record: %w", err)
	}

	return attachment, nil
}
