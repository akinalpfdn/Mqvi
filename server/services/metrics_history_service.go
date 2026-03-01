// Package services — MetricsHistoryService, tarihsel metrik özet sorgulama.
//
// Thin service layer — handler ile repository arasında validation ve
// business logic katmanı sağlar.
package services

import (
	"context"
	"fmt"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg"
	"github.com/akinalp/mqvi/repository"
)

// MetricsHistoryService, tarihsel metrik özetlerine erişim interface'i.
type MetricsHistoryService interface {
	// GetSummary, belirli bir instance ve zaman aralığı için
	// peak/average metrik özeti döner.
	// period: "24h", "7d", "30d"
	GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error)
}

type metricsHistoryService struct {
	historyRepo repository.MetricsHistoryRepository
	livekitRepo repository.LiveKitRepository
}

// NewMetricsHistoryService, constructor — interface döner.
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
	// 1. Period validation
	if !isValidPeriod(period) {
		return nil, fmt.Errorf("%w: invalid period %q (expected 24h, 7d, or 30d)", pkg.ErrBadRequest, period)
	}

	// 2. Instance varlığını kontrol et
	_, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// 3. Summary'yi getir
	summary, err := s.historyRepo.GetSummary(ctx, instanceID, period)
	if err != nil {
		return nil, fmt.Errorf("failed to get metrics history summary: %w", err)
	}

	return summary, nil
}

// isValidPeriod, period string'inin geçerli olup olmadığını kontrol eder.
func isValidPeriod(period string) bool {
	switch period {
	case "24h", "7d", "30d":
		return true
	default:
		return false
	}
}
