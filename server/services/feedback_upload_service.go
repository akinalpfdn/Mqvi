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
	"github.com/google/uuid"
)

type FeedbackUploadService interface {
	Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error)
}

type feedbackUploadService struct {
	feedbackRepo repository.FeedbackRepository
	uploadDir    string
	maxSize      int64
}

func NewFeedbackUploadService(
	feedbackRepo repository.FeedbackRepository,
	uploadDir string,
	maxSize int64,
) FeedbackUploadService {
	return &feedbackUploadService{
		feedbackRepo: feedbackRepo,
		uploadDir:    uploadDir,
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
	att := &models.FeedbackAttachment{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		ReplyID:  replyID,
		Filename: header.Filename,
		FileURL:  "/api/uploads/" + diskFilename,
		FileSize: &fileSize,
		MimeType: &mimeBase,
	}

	if err := s.feedbackRepo.CreateAttachment(ctx, att); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to create feedback attachment record: %w", err)
	}

	return att, nil
}
