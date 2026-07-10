// Package services — ServerReportUploadService: evidence image upload for server reports.
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

// ServerReportUploadService stores evidence images for server reports.
type ServerReportUploadService interface {
	Upload(ctx context.Context, serverReportID string, file multipart.File, header *multipart.FileHeader) (*models.ServerReportAttachment, error)
}

type serverReportUploadService struct {
	repo     repository.ServerReportRepository
	pipeline UploadPipeline
	maxSize  int64
}

func NewServerReportUploadService(repo repository.ServerReportRepository, pipeline UploadPipeline, maxSize int64) ServerReportUploadService {
	return &serverReportUploadService{repo: repo, pipeline: pipeline, maxSize: maxSize}
}

func (s *serverReportUploadService) Upload(ctx context.Context, serverReportID string, file multipart.File, header *multipart.FileHeader) (*models.ServerReportAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	mimeBase := strings.TrimSpace(strings.Split(contentType, ";")[0])
	if !allowedReportMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: only images are allowed for report evidence (got: %s)", pkg.ErrBadRequest, mimeBase)
	}

	stored, err := s.pipeline.Store(ctx, files.KindServerReport, serverReportID, file, header, s.maxSize)
	if err != nil {
		return nil, err
	}

	fileSize := stored.Size
	att := &models.ServerReportAttachment{
		ServerReportID: serverReportID,
		Filename:       header.Filename,
		FileURL:        stored.RelativeURL,
		FileSize:       &fileSize,
		MimeType:       &mimeBase,
	}
	if err := s.repo.CreateAttachment(ctx, att); err != nil {
		s.pipeline.DeleteFromURL(stored.RelativeURL)
		return nil, fmt.Errorf("failed to create server report attachment record: %w", err)
	}
	return att, nil
}
