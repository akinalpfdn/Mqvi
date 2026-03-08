package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// MetricsHistoryService provides historical metrics summary queries.
type MetricsHistoryService interface {
	// GetSummary returns peak/average metrics for an instance and time period.
	GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error)
	// GetTimeSeries returns time series data points for charting.
	GetTimeSeries(ctx context.Context, instanceID string, period string) ([]models.MetricsTimeSeriesPoint, error)
}

type metricsHistoryService struct {
	historyRepo repository.MetricsHistoryRepository
	livekitRepo repository.LiveKitRepository
}

func NewMetricsHistoryService(
	historyRepo repository.MetricsHistoryRepository,
	livekitRepo repository.LiveKitRepository,
) MetricsHistoryService {
	return &metricsHistoryService{
		historyRepo: historyRepo,
		livekitRepo: livekitRepo,
	}
}

func (s *metricsHistoryService) GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error) {
	if !isValidPeriod(period) {
		return nil, fmt.Errorf("%w: invalid period %q (expected 24h, 7d, or 30d)", pkg.ErrBadRequest, period)
	}

	_, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	summary, err := s.historyRepo.GetSummary(ctx, instanceID, period)
	if err != nil {
		return nil, fmt.Errorf("failed to get metrics history summary: %w", err)
	}

	return summary, nil
}

func (s *metricsHistoryService) GetTimeSeries(ctx context.Context, instanceID string, period string) ([]models.MetricsTimeSeriesPoint, error) {
	if !isValidPeriod(period) {
		return nil, fmt.Errorf("%w: invalid period %q (expected 24h, 7d, or 30d)", pkg.ErrBadRequest, period)
	}

	_, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	points, err := s.historyRepo.GetTimeSeries(ctx, instanceID, period)
	if err != nil {
		return nil, fmt.Errorf("failed to get metrics time series: %w", err)
	}

	return points, nil
}

func isValidPeriod(period string) bool {
	switch period {
	case "24h", "7d", "30d":
		return true
	default:
		return false
	}
}
