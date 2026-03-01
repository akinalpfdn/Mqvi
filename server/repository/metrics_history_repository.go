// Package repository — MetricsHistoryRepository, tarihsel LiveKit metrik
// verilerinin data access interface'i.
//
// LiveKitRepository'den Interface Segregation ile ayrı tutulur —
// farklı consumer'lar (MetricsCollector yazma, MetricsHistoryService okuma)
// farklı ihtiyaçlara sahiptir.
package repository

import (
	"context"
	"time"

	"github.com/akinalp/mqvi/models"
)

// MetricsHistoryRepository, tarihsel metrik verisi için data access interface.
type MetricsHistoryRepository interface {
	// Insert, yeni bir metrik snapshot'ı kaydeder.
	// MetricsCollector tarafından her 5 dakikada çağrılır.
	Insert(ctx context.Context, snapshot *models.MetricsSnapshot) error

	// GetSummary, belirli bir instance ve zaman aralığı için
	// SQL aggregate (MAX, AVG) ile özet döner.
	// period: "24h", "7d", "30d" — caller tarafından validate edilmiş olmalı.
	GetSummary(ctx context.Context, instanceID string, period string) (*models.MetricsHistorySummary, error)

	// PurgeOlderThan, belirtilen tarihten eski kayıtları siler.
	// MetricsCollector tarafından her tick'te çağrılır (30 gün retention).
	// Silinen satır sayısını döner.
	PurgeOlderThan(ctx context.Context, before time.Time) (int64, error)
}
