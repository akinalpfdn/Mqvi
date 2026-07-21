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
	"github.com/google/uuid"
)

type FeedbackUploadService interface {
	Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error)
}

type feedbackUploadService struct {
	feedbackRepo repository.FeedbackRepository
	pipeline     UploadPipeline
	maxSize      int64
}

func NewFeedbackUploadService(
	feedbackRepo repository.FeedbackRepository,
	pipeline UploadPipeline,
	maxSize int64,
) FeedbackUploadService {
	return &feedbackUploadService{
		feedbackRepo: feedbackRepo,
		pipeline:     pipeline,
		maxSize:      maxSize,
	}
}

var allowedFeedbackMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// Video by prefix, not an enumerated list, which always misses a .mov or .m4v. The extension only
// vetoes genuinely dangerous types (".html" claimed as "video/mp4") — requiring it to resolve to
// video/ refused legitimate files, since Go maps .webm to audio/webm and does not know .mkv.
func isAllowedFeedbackMime(mimeBase, filename string) bool {
	if strings.HasPrefix(mimeBase, "video/") {
		return !files.IsUnsafeInline(files.MIMEByExtension(filename))
	}
	return allowedFeedbackMimeTypes[mimeBase]
}

func (s *feedbackUploadService) Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.TrimSpace(strings.Split(contentType, ";")[0])

	if !isAllowedFeedbackMime(mimeBase, header.Filename) {
		return nil, fmt.Errorf("%w: only images and video are allowed (got: %s)", pkg.ErrBadRequest, mimeBase)
	}

	stored, err := s.pipeline.Store(ctx, files.KindFeedback, ticketID, file, header, s.maxSize)
	if err != nil {
		return nil, err
	}

	fileSize := stored.Size
	att := &models.FeedbackAttachment{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		ReplyID:  replyID,
		Filename: header.Filename,
		FileURL:  stored.RelativeURL,
		FileSize: &fileSize,
		MimeType: &mimeBase,
	}

	if err := s.feedbackRepo.CreateAttachment(ctx, att); err != nil {
		s.pipeline.DeleteFromURL(stored.RelativeURL)
		return nil, fmt.Errorf("failed to create feedback attachment record: %w", err)
	}

	return att, nil
}
