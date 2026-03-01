// Package services — MetricsCollector, periyodik arka plan metrik toplama servisi.
//
// Her 5 dakikada tüm platform-managed LiveKit instance'lardan Prometheus
// /metrics endpoint'ini çeker, derived metrikleri (CPU %, bandwidth rate)
// hesaplar ve MetricsHistoryRepository üzerinden SQLite'a yazar.
//
// Derived metrikler Prometheus counter delta'larından hesaplanır:
//   - CPU %: process_cpu_seconds_total farkı / zaman farkı * 100
//   - Bandwidth rate: livekit_packet_bytes farkı / zaman farkı
//
// Goroutine pattern: time.NewTicker + select + stopCh (pkg/cache/ttl_cache.go ile aynı).
// Graceful shutdown: main.go'da collector.Stop() çağrılır.
package services

import (
	"context"
	"crypto/tls"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/promparse"
	"github.com/akinalp/mqvi/repository"
)

// MetricsCollector, periyodik arka plan metrik toplama interface'i.
type MetricsCollector interface {
	// Start, collector goroutine'ini başlatır.
	// main.go'da initServices sonrasında çağrılır.
	Start()

	// Stop, collector goroutine'ini durdurur.
	// main.go'da graceful shutdown sırasında çağrılır.
	Stop()
}

// previousSample, CPU ve bandwidth delta hesaplaması için
// bir önceki sample'ın counter değerlerini tutar.
// Counter'lar monotonically increasing olduğundan delta hesaplanabilir.
type previousSample struct {
	cpuSeconds float64
	bytesIn    uint64
	bytesOut   uint64
	timestamp  time.Time
}

type metricsCollector struct {
	livekitRepo repository.LiveKitRepository
	historyRepo repository.MetricsHistoryRepository
	httpClient  *http.Client

	interval      time.Duration
	retentionDays int

	// In-memory state for delta computation.
	// Goroutine-safe: sadece collector goroutine'i erişir.
	prevSamples map[string]*previousSample

	stopCh chan struct{}
	mu     sync.Mutex // Start/Stop race koruması
}

// NewMetricsCollector, constructor.
//
// interval: metrik toplama aralığı (production: 5*time.Minute).
// retentionDays: eski verilerin tutulacağı gün sayısı (default: 30).
func NewMetricsCollector(
	livekitRepo repository.LiveKitRepository,
	historyRepo repository.MetricsHistoryRepository,
	interval time.Duration,
	retentionDays int,
) MetricsCollector {
	return &metricsCollector{
		livekitRepo:   livekitRepo,
		historyRepo:   historyRepo,
		interval:      interval,
		retentionDays: retentionDays,
		prevSamples:   make(map[string]*previousSample),
		stopCh:        make(chan struct{}),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

// Start, collector goroutine'ini başlatır.
// İlk collection hemen çalışır, sonra interval aralığında tekrarlar.
func (c *metricsCollector) Start() {
	c.mu.Lock()
	defer c.mu.Unlock()

	log.Printf("[metrics-collector] starting (interval=%s, retention=%dd)", c.interval, c.retentionDays)

	go func() {
		// İlk collection'ı hemen yap — server start'ta beklemeden veri topla
		c.collectAll()

		ticker := time.NewTicker(c.interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				c.collectAll()
			case <-c.stopCh:
				log.Println("[metrics-collector] stopped")
				return
			}
		}
	}()
}

// Stop, collector goroutine'ini durdurur.
func (c *metricsCollector) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()

	close(c.stopCh)
}

// collectAll, tüm platform-managed instance'lardan metrik toplar.
func (c *metricsCollector) collectAll() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. Tüm platform-managed instance'ları al
	instances, err := c.livekitRepo.ListPlatformInstances(ctx)
	if err != nil {
		log.Printf("[metrics-collector] failed to list instances: %v", err)
		return
	}

	if len(instances) == 0 {
		return
	}

	// 2. Her instance için metrik topla
	now := time.Now().UTC()
	for i := range instances {
		c.collectOne(ctx, &instances[i], now)
	}

	// 3. Eski verileri temizle (retention period'u geçenleri sil)
	cutoff := now.Add(-time.Duration(c.retentionDays) * 24 * time.Hour)
	purged, purgeErr := c.historyRepo.PurgeOlderThan(ctx, cutoff)
	if purgeErr != nil {
		log.Printf("[metrics-collector] purge error: %v", purgeErr)
	} else if purged > 0 {
		log.Printf("[metrics-collector] purged %d old snapshots", purged)
	}
}

// collectOne, tek bir instance'dan metrik çeker ve DB'ye yazar.
func (c *metricsCollector) collectOne(ctx context.Context, inst *models.LiveKitInstance, now time.Time) {
	metricsURL := LiveKitURLToMetrics(inst.URL)

	// HTTP GET /metrics
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metricsURL, nil)
	if err != nil {
		c.insertUnavailable(ctx, inst.ID)
		return
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		c.insertUnavailable(ctx, inst.ID)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.insertUnavailable(ctx, inst.ID)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		c.insertUnavailable(ctx, inst.ID)
		return
	}

	// Prometheus parse
	m := promparse.Parse(string(body))

	// Raw değerler
	roomCount := m.Int("livekit_room_total")
	participantCount := m.Int("livekit_participant_total")
	memoryBytes := m.Uint64("process_resident_memory_bytes")
	goroutines := m.Int("go_goroutines")
	bytesIn := m.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming")
	bytesOut := m.Uint64WithLabel("livekit_packet_bytes", "direction", "outgoing")
	cpuSeconds := m.Float64("process_cpu_seconds_total")

	// Derived metrikler — delta hesaplaması
	var cpuPct, bwInBps, bwOutBps float64

	prev := c.prevSamples[inst.ID]
	if prev != nil {
		elapsed := now.Sub(prev.timestamp).Seconds()
		if elapsed > 0 {
			// CPU %: counter delta / zaman delta
			// Counter reset tespiti: delta < 0 ise 0 kullan (LiveKit restart)
			cpuDelta := cpuSeconds - prev.cpuSeconds
			if cpuDelta >= 0 {
				cpuPct = (cpuDelta / elapsed) * 100
			}

			// Bandwidth rate (bytes/sec)
			if bytesIn >= prev.bytesIn {
				bwInBps = float64(bytesIn-prev.bytesIn) / elapsed
			}
			if bytesOut >= prev.bytesOut {
				bwOutBps = float64(bytesOut-prev.bytesOut) / elapsed
			}
		}
	}

	// Mevcut sample'ı sakla (sonraki tick için delta referansı)
	c.prevSamples[inst.ID] = &previousSample{
		cpuSeconds: cpuSeconds,
		bytesIn:    bytesIn,
		bytesOut:   bytesOut,
		timestamp:  now,
	}

	// DB'ye yaz
	snapshot := &models.MetricsSnapshot{
		InstanceID:       inst.ID,
		RoomCount:        roomCount,
		ParticipantCount: participantCount,
		MemoryBytes:      memoryBytes,
		Goroutines:       goroutines,
		BytesIn:          bytesIn,
		BytesOut:         bytesOut,
		CPUPercent:       cpuPct,
		BandwidthInBps:   bwInBps,
		BandwidthOutBps:  bwOutBps,
		Available:        true,
	}

	if insertErr := c.historyRepo.Insert(ctx, snapshot); insertErr != nil {
		log.Printf("[metrics-collector] insert error for %s: %v", inst.ID, insertErr)
	}
}

// insertUnavailable, /metrics erişilemediğinde available=false kayıt yazar.
// Tarihsel olarak downtime'ı da takip edebilmek için.
func (c *metricsCollector) insertUnavailable(ctx context.Context, instanceID string) {
	snapshot := &models.MetricsSnapshot{
		InstanceID: instanceID,
		Available:  false,
	}

	if err := c.historyRepo.Insert(ctx, snapshot); err != nil {
		log.Printf("[metrics-collector] insert unavailable error for %s: %v", instanceID, err)
	}
}
