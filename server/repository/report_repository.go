package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ReportRepository defines data access for user reports.
type ReportRepository interface {
	Create(ctx context.Context, report *models.Report) error
	GetByID(ctx context.Context, id string) (*models.Report, error)
	// ListPending returns pending reports with pagination. Also returns totalCount.
	ListPending(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error)
	// ListAll returns all reports (any status) with pagination. Also returns totalCount.
	ListAll(ctx context.Context, limit, offset int) ([]models.ReportWithUsers, int, error)
	UpdateStatus(ctx context.Context, id string, status models.ReportStatus, resolvedBy string) error
	// HasPendingReport checks if an active (pending) report exists for this reporter->target pair.
	HasPendingReport(ctx context.Context, reporterID, targetID string) (bool, error)
	// CreateAttachment adds an evidence file to a report.
	CreateAttachment(ctx context.Context, att *models.ReportAttachment) error
	GetAttachmentsByReportID(ctx context.Context, reportID string) ([]models.ReportAttachment, error)
}
