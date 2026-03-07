// Package services — MetricsCollector, periyodik arka plan metrik toplama servisi.
//
// Her 5 dakikada tüm platform-managed LiveKit instance'lardan metrik toplar:
//   - LiveKit /metrics endpoint'inden: room_count, participant_count, memory, goroutines
//   - Hetzner Cloud API'den (varsa): CPU %, network bandwidth
//
// Hetzner entegrasyonu opsiyoneldir:
//   - hetzner_server_id boş → eski davranış, LiveKit process CPU kullanılır
//   - hetzner_server_id dolu + HETZNER_API_TOKEN set → gerçek sunucu CPU/BW
//
// CPU normalizasyonu: Hetzner max CPU = vCPU_count * 100%. Normalize ederek
// 0-100% aralığına çevrilir (4 vCPU'da 350% → 87.5%).
// vCPU sayısı ilk metrik collection'da Hetzner API'den çekilip cache'lenir.
package services

import (
	"context"
	"crypto/tls"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/akinalp/mqvi/models"
	"github.com/akinalp/mqvi/pkg/promparse"
	"github.com/akinalp/mqvi/repository"
	"github.com/hetznercloud/hcloud-go/v2/hcloud"
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

	// Hetzner Cloud API — opsiyonel.
	// hetznerClient nil ise Hetzner entegrasyonu devre dışıdır.
	hetznerClient *hcloud.Client

	// vCPU count cache — Hetzner sunucusunun vCPU sayısı.
	// İlk metrik collection'da API'den çekilir, sonra cache'lenir.
	// Key: Hetzner server ID (int64), Value: vCPU count.
	vcpuCache map[int64]int

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
// hetznerToken: Hetzner Cloud API token — boş string ise Hetzner devre dışı.
func NewMetricsCollector(
	livekitRepo repository.LiveKitRepository,
	historyRepo repository.MetricsHistoryRepository,
	interval time.Duration,
	retentionDays int,
	hetznerToken string,
) MetricsCollector {
	mc := &metricsCollector{
		livekitRepo:   livekitRepo,
		historyRepo:   historyRepo,
		interval:      interval,
		retentionDays: retentionDays,
		prevSamples:   make(map[string]*previousSample),
		vcpuCache:     make(map[int64]int),
		stopCh:        make(chan struct{}),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}

	if hetznerToken != "" {
		mc.hetznerClient = hcloud.NewClient(hcloud.WithToken(hetznerToken))
		log.Println("[metrics-collector] Hetzner Cloud API enabled")
	}

	return mc
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

	// Raw değerler — LiveKit /metrics'ten her zaman çekiyoruz
	roomCount := m.Int("livekit_room_total")
	participantCount := m.Int("livekit_participant_total")
	memoryBytes := m.Uint64("process_resident_memory_bytes")
	goroutines := m.Int("go_goroutines")
	bytesIn := m.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming")
	bytesOut := m.Uint64WithLabel("livekit_packet_bytes", "direction", "outgoing")
	cpuSeconds := m.Float64("process_cpu_seconds_total")

	// Derived metrikler — Hetzner varsa API'den, yoksa LiveKit delta'larından
	var cpuPct, bwInBps, bwOutBps float64

	hetznerUsed := false
	if inst.HetznerServerID != "" && c.hetznerClient != nil {
		hCPU, hBwIn, hBwOut, hErr := c.fetchHetznerMetrics(ctx, inst.HetznerServerID, now)
		if hErr != nil {
			log.Printf("[metrics-collector] hetzner API error for %s (server %s): %v", inst.ID, inst.HetznerServerID, hErr)
			// Hetzner başarısız → LiveKit fallback
		} else {
			cpuPct = hCPU
			bwInBps = hBwIn
			bwOutBps = hBwOut
			hetznerUsed = true
		}
	}

	// Hetzner kullanılmadıysa → LiveKit process delta hesaplaması (eski davranış)
	if !hetznerUsed {
		prev := c.prevSamples[inst.ID]
		if prev != nil {
			elapsed := now.Sub(prev.timestamp).Seconds()
			if elapsed > 0 {
				cpuDelta := cpuSeconds - prev.cpuSeconds
				if cpuDelta >= 0 {
					cpuPct = (cpuDelta / elapsed) * 100
				}

				if bytesIn >= prev.bytesIn {
					bwInBps = float64(bytesIn-prev.bytesIn) / elapsed
				}
				if bytesOut >= prev.bytesOut {
					bwOutBps = float64(bytesOut-prev.bytesOut) / elapsed
				}
			}
		}
	}

	// Mevcut sample'ı sakla (sonraki tick için delta referansı — Hetzner olmasa da)
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

// fetchHetznerMetrics, Hetzner Cloud API'den CPU ve network metriklerini çeker.
// CPU: vCPU sayısına bölünerek 0-100% normalize edilir.
// Bandwidth: bytes/sec olarak döner.
func (c *metricsCollector) fetchHetznerMetrics(ctx context.Context, hetznerServerIDStr string, now time.Time) (cpuPct, bwIn, bwOut float64, err error) {
	serverID, err := strconv.ParseInt(hetznerServerIDStr, 10, 64)
	if err != nil {
		return 0, 0, 0, err
	}

	// vCPU sayısını cache'den al veya API'den çek
	vcpuCount, vcpuErr := c.getVCPUCount(ctx, serverID)
	if vcpuErr != nil {
		return 0, 0, 0, vcpuErr
	}

	// Hetzner API'den metrik çek — son interval kadar pencere
	start := now.Add(-c.interval)
	result, _, apiErr := c.hetznerClient.Server.GetMetrics(ctx, &hcloud.Server{ID: serverID}, hcloud.ServerGetMetricsOpts{
		Types: []hcloud.ServerMetricType{
			hcloud.ServerMetricCPU,
			hcloud.ServerMetricNetwork,
		},
		Start: start,
		End:   now,
	})
	if apiErr != nil {
		return 0, 0, 0, apiErr
	}

	// CPU — son değeri al ve vCPU ile normalize et
	if cpuValues, ok := result.TimeSeries["cpu"]; ok && len(cpuValues) > 0 {
		lastVal := cpuValues[len(cpuValues)-1]
		rawCPU, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil && vcpuCount > 0 {
			// Hetzner: 4 vCPU'da max 400%, normalize → 0-100%
			cpuPct = rawCPU / float64(vcpuCount)
		}
	}

	// Network in — son değer (bytes/sec)
	if inValues, ok := result.TimeSeries["network.0.bandwidth.in"]; ok && len(inValues) > 0 {
		lastVal := inValues[len(inValues)-1]
		parsed, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil {
			bwIn = parsed
		}
	}

	// Network out — son değer (bytes/sec)
	if outValues, ok := result.TimeSeries["network.0.bandwidth.out"]; ok && len(outValues) > 0 {
		lastVal := outValues[len(outValues)-1]
		parsed, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil {
			bwOut = parsed
		}
	}

	return cpuPct, bwIn, bwOut, nil
}

// getVCPUCount, Hetzner sunucusunun vCPU sayısını döner.
// İlk çağrıda API'den çeker ve cache'e yazar.
// Sonraki çağrılarda cache'den döner (server type değişmediği sürece).
func (c *metricsCollector) getVCPUCount(ctx context.Context, serverID int64) (int, error) {
	if count, ok := c.vcpuCache[serverID]; ok {
		return count, nil
	}

	// Hetzner API'den server bilgisini çek
	server, _, err := c.hetznerClient.Server.GetByID(ctx, serverID)
	if err != nil {
		return 0, err
	}
	if server == nil {
		return 0, nil
	}

	cores := 1 // fallback
	if server.ServerType != nil && server.ServerType.Cores > 0 {
		cores = server.ServerType.Cores
	}

	c.vcpuCache[serverID] = cores
	log.Printf("[metrics-collector] cached vCPU count for Hetzner server %d: %d cores", serverID, cores)

	return cores, nil
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
