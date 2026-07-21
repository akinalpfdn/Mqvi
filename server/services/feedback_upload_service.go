package services

import (
	"context"
	"fmt"
	"mime/multipart"
	"path"
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

// allowedFeedbackVideoExts is the container list a video attachment may carry.
//
// A fixed list rather than a veto on "dangerous" extensions: the Content-Type is the client's claim
// and nothing more, so an unknown extension used to pass — "video/mp4" on payload.exe was accepted
// whenever the host's MIME database did not resolve .exe, which made the decision depend on the
// machine the server happened to run on. An allowlist decides the same way everywhere.
var allowedFeedbackVideoExts = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".webm": true,
	".mkv": true, ".avi": true, ".ogv": true, ".3gp": true,
}

// Images get the same treatment as video. The declared type alone let "image/png" on payload.exe
// through: not an XSS, since the serve layer forces a download, but arbitrary file hosting all the
// same — the exact thing the video branch was tightened to prevent.
var allowedFeedbackImageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
}

func isAllowedFeedbackMime(mimeBase, filename string) bool {
	ext := strings.ToLower(path.Ext(filename))
	if strings.HasPrefix(mimeBase, "video/") {
		return allowedFeedbackVideoExts[ext]
	}
	return allowedFeedbackMimeTypes[mimeBase] && allowedFeedbackImageExts[ext]
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
