package repository

import (
	"context"

	"github.com/akinalp/mqvi/models"
)

// ServerReportRepository stores user reports against public servers (discovery moderation).
type ServerReportRepository interface {
	Create(ctx context.Context, report *models.ServerReport) error
	// HasPending reports whether the reporter already has an open report for this server.
	HasPending(ctx context.Context, reporterID, serverID string) (bool, error)
	// ListForAdmin returns reports (all, or pending-only when status=="pending") with reporter +
	// server names, plus the total count.
	ListForAdmin(ctx context.Context, status string, limit, offset int) ([]models.ServerReportWithInfo, int, error)
	UpdateStatus(ctx context.Context, reportID string, status models.ReportStatus, adminID string) error
}
