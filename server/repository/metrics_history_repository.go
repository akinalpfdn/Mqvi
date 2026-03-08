package repository

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
)

// MetricsHistoryRepository defines data access for historical LiveKit metrics.
// Separated from LiveKitRepository via ISP — different consumers have different needs.
type MetricsHistoryRepository interface {
	// Insert saves a metrics snapshot. Called every 5 minutes by MetricsCollector.
	Insert(ctx context.Context, snapshot *models.MetricsSnapshot) error

	// GetSummary returns SQL aggregates (MAX, AVG) for a given instance and period ("24h", "7d", "30d").
	GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error)

	// GetTimeSeries returns raw or aggregated data points for charting.
	// 24h: raw (5min intervals), 7d: hourly avg, 30d: 6-hour avg.
	GetTimeSeries(ctx context.Context, instanceID string, period string) ([]models.MetricsTimeSeriesPoint, error)

	// PurgeOlderThan deletes records older than the given time. Returns deleted row count.
	PurgeOlderThan(ctx context.Context, before time.Time) (int64, error)
}
