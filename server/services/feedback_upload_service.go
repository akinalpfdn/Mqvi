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
	"github.com/google/uuid"
)

type FeedbackUploadService interface {
	Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error)
}

type feedbackUploadService struct {
	feedbackRepo repository.FeedbackRepository
	locator      *files.Locator
	maxSize      int64
}

func NewFeedbackUploadService(
	feedbackRepo repository.FeedbackRepository,
	locator *files.Locator,
	maxSize int64,
) FeedbackUploadService {
	return &feedbackUploadService{
		feedbackRepo: feedbackRepo,
		locator:      locator,
		maxSize:      maxSize,
	}
}

var allowedFeedbackMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
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

	if !allowedFeedbackMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: only images are allowed (got: %s)", pkg.ErrBadRequest, mimeBase)
	}

	diskFilename, err := files.GenerateDiskFilename(header.Filename)
	if err != nil {
		return nil, err
	}

	relURL, err := s.locator.SaveFile(files.KindFeedback, ticketID, diskFilename, func(dst *os.File) error {
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
	att := &models.FeedbackAttachment{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		ReplyID:  replyID,
		Filename: header.Filename,
		FileURL:  relURL,
		FileSize: &fileSize,
		MimeType: &mimeBase,
	}

	if err := s.feedbackRepo.CreateAttachment(ctx, att); err != nil {
		s.locator.DeleteFromURL(relURL)
		return nil, fmt.Errorf("failed to create feedback attachment record: %w", err)
	}

	return att, nil
}
