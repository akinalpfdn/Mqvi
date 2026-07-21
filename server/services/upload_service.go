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

// UploadService handles file upload validation, storage, and DB record creation.
// isEncrypted: E2EE files are client-side AES-256-GCM encrypted, sent as
// application/octet-stream — MIME whitelist is skipped for these.
type UploadService interface {
	Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool, thumb *ThumbnailUpload) (*models.Attachment, error)
}

type uploadService struct {
	attachmentRepo repository.AttachmentRepository
	pipeline       UploadPipeline
	maxSize        int64
}

func NewUploadService(
	attachmentRepo repository.AttachmentRepository,
	pipeline UploadPipeline,
	maxSize int64,
) UploadService {
	return &uploadService{
		attachmentRepo: attachmentRepo,
		pipeline:       pipeline,
		maxSize:        maxSize,
	}
}

// All file types are accepted on upload. XSS protection is handled at serve-time
// via Content-Disposition: attachment for non-media types (see pkg/files/safemime.go).

func (s *uploadService) Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool, thumb *ThumbnailUpload) (*models.Attachment, error) {
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

	stored, err := s.pipeline.Store(ctx, files.KindMessage, messageID, file, header, s.maxSize)
	if err != nil {
		return nil, err
	}

	fileSize := stored.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  header.Filename,
		FileURL:   stored.RelativeURL,
		FileSize:  &fileSize,
		MimeType:  &mimeBase,
	}
	if t := storeThumbnail(ctx, s.pipeline, files.KindMessage, messageID, thumb); t != nil {
		attachment.ThumbURL, attachment.ThumbWidth, attachment.ThumbHeight = &t.URL, t.Width, t.Height
		attachment.ThumbSize = &t.Size
	}

	if err := s.attachmentRepo.Create(ctx, attachment); err != nil {
		s.pipeline.DeleteFromURL(stored.RelativeURL)
		// The thumbnail was stored before the row existed; without this it would sit on disk with
		// nothing referencing it and no cleanup query able to find it.
		if attachment.ThumbURL != nil {
			s.pipeline.DeleteFromURL(*attachment.ThumbURL)
		}
		return nil, fmt.Errorf("failed to create attachment record: %w", err)
	}

	return attachment, nil
}
