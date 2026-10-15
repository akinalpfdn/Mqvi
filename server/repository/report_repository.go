package repository

import (
	"context"
	"time"

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
	// HasPendingReport checks if an active (pending) report exists for this
	// reporter->target pair with the same message context (empty IDs = profile report).
	HasPendingReport(ctx context.Context, reporterID, targetID, messageID, dmMessageID, voiceMessageID string) (bool, error)
	// CreateAttachment adds an evidence file to a report.
	CreateAttachment(ctx context.Context, att *models.ReportAttachment) error
	GetAttachmentsByReportID(ctx context.Context, reportID string) ([]models.ReportAttachment, error)

	// LatestCreatedAt returns the newest report's created_at, or nil when the
	// table is empty. Drives the admin "new report" badge.
	LatestCreatedAt(ctx context.Context) (*time.Time, error)
}
