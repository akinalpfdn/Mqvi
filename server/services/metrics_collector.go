// Package services — MetricsCollector: periodic background metrics collection.
//
// Collects metrics from all platform-managed LiveKit instances every interval:
//   - LiveKit /metrics (Prometheus): room_count, participant_count, memory, goroutines
//   - Hetzner Cloud API (optional): CPU %, network bandwidth
//
// CPU normalization: Hetzner reports max CPU = vCPU_count * 100%.
// Normalized to 0-100% (e.g. 350% on 4 vCPU -> 87.5%).
// vCPU count is fetched from Hetzner API on first collection and cached.
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

// MetricsCollector runs periodic background metric collection.
type MetricsCollector interface {
	Start()
	Stop()
}

// previousSample holds counter values from the last sample for CPU/bandwidth delta computation.
type previousSample struct {
	cpuSeconds float64
	bytesIn    uint64
	bytesOut   uint64
	timestamp  time.Time
}

// ScreenShareCounter provides current screen share count for periodic metric snapshots.
type ScreenShareCounter interface {
	GetScreenShareStats() (streamers int, viewers int)
}

type metricsCollector struct {
	livekitRepo repository.LiveKitRepository
	historyRepo repository.MetricsHistoryRepository
	httpClient  *http.Client

	interval      time.Duration
	retentionDays int

	hetznerClient    *hcloud.Client // optional, nil = disabled
	vcpuCache        map[int64]int  // cached vCPU counts per Hetzner server ID
	screenShareStats ScreenShareCounter // optional, nil = no screen share tracking

	// Delta computation state. Goroutine-safe: only accessed by collector goroutine.
	prevSamples map[string]*previousSample

	stopCh chan struct{}
	mu     sync.Mutex // Start/Stop race protection
}

func NewMetricsCollector(
	livekitRepo repository.LiveKitRepository,
	historyRepo repository.MetricsHistoryRepository,
	interval time.Duration,
	retentionDays int,
	hetznerToken string,
	screenShareStats ScreenShareCounter,
) MetricsCollector {
	mc := &metricsCollector{
		livekitRepo:      livekitRepo,
		historyRepo:      historyRepo,
		interval:         interval,
		retentionDays:    retentionDays,
		screenShareStats: screenShareStats,
		prevSamples:      make(map[string]*previousSample),
		vcpuCache:        make(map[int64]int),
		stopCh:           make(chan struct{}),
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

// Start launches the collector goroutine. First collection runs immediately.
func (c *metricsCollector) Start() {
	c.mu.Lock()
	defer c.mu.Unlock()

	log.Printf("[metrics-collector] starting (interval=%s, retention=%dd)", c.interval, c.retentionDays)

	go func() {
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

func (c *metricsCollector) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()

	close(c.stopCh)
}

func (c *metricsCollector) collectAll() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	instances, err := c.livekitRepo.ListPlatformInstances(ctx)
	if err != nil {
		log.Printf("[metrics-collector] failed to list instances: %v", err)
		return
	}

	if len(instances) == 0 {
		return
	}

	now := time.Now().UTC()
	for i := range instances {
		c.collectOne(ctx, &instances[i], now)
	}

	// Purge expired data
	cutoff := now.Add(-time.Duration(c.retentionDays) * 24 * time.Hour)
	purged, purgeErr := c.historyRepo.PurgeOlderThan(ctx, cutoff)
	if purgeErr != nil {
		log.Printf("[metrics-collector] purge error: %v", purgeErr)
	} else if purged > 0 {
		log.Printf("[metrics-collector] purged %d old snapshots", purged)
	}
}

// collectOne fetches metrics from a single instance.
// Two independent sources: LiveKit /metrics and Hetzner API.
// Either can fail independently — the other is still recorded.
func (c *metricsCollector) collectOne(ctx context.Context, inst *models.LiveKitInstance, now time.Time) {
	var roomCount, participantCount, goroutines int
	var memoryBytes, bytesIn, bytesOut uint64
	var cpuSeconds float64
	livekitOK := false

	// 1. LiveKit /metrics
	metricsURL := LiveKitURLToMetrics(inst.URL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metricsURL, nil)
	if err == nil {
		resp, httpErr := c.httpClient.Do(req)
		if httpErr == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				body, readErr := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
				if readErr == nil {
					m := promparse.Parse(string(body))
					roomCount = m.Int("livekit_room_total")
					participantCount = m.Int("livekit_participant_total")
					memoryBytes = m.Uint64("process_resident_memory_bytes")
					goroutines = m.Int("go_goroutines")
					bytesIn = m.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming")
					bytesOut = m.Uint64WithLabel("livekit_packet_bytes", "direction", "outgoing")
					cpuSeconds = m.Float64("process_cpu_seconds_total")
					livekitOK = true
				}
			}
		}
	}

	// 2. CPU & bandwidth — Hetzner API if available, otherwise LiveKit delta fallback
	var cpuPct, bwInBps, bwOutBps float64
	hetznerOK := false

	if inst.HetznerServerID != "" && c.hetznerClient != nil {
		hCPU, hBwIn, hBwOut, hErr := c.fetchHetznerMetrics(ctx, inst.HetznerServerID, now)
		if hErr != nil {
			log.Printf("[metrics-collector] hetzner API error for %s (server %s): %v", inst.ID, inst.HetznerServerID, hErr)
		} else {
			cpuPct = hCPU
			bwInBps = hBwIn
			bwOutBps = hBwOut
			hetznerOK = true
		}
	}

	// Fallback: LiveKit process delta when Hetzner is unavailable
	if !hetznerOK && livekitOK {
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

	if !livekitOK && !hetznerOK {
		c.insertUnavailable(ctx, inst.ID)
		return
	}

	// Update delta reference
	if livekitOK {
		c.prevSamples[inst.ID] = &previousSample{
			cpuSeconds: cpuSeconds,
			bytesIn:    bytesIn,
			bytesOut:   bytesOut,
			timestamp:  now,
		}
	}

	var screenShareCount int
	if c.screenShareStats != nil {
		screenShareCount, _ = c.screenShareStats.GetScreenShareStats()
	}

	snapshot := &models.MetricsSnapshot{
		InstanceID:       inst.ID,
		RoomCount:        roomCount,
		ParticipantCount: participantCount,
		MemoryBytes:      memoryBytes,
		Goroutines:       goroutines,
		BytesIn:          bytesIn,
		BytesOut:         bytesOut,
		ScreenShareCount: screenShareCount,
		CPUPercent:       cpuPct,
		BandwidthInBps:   bwInBps,
		BandwidthOutBps:  bwOutBps,
		Available:        true,
	}

	if insertErr := c.historyRepo.Insert(ctx, snapshot); insertErr != nil {
		log.Printf("[metrics-collector] insert error for %s: %v", inst.ID, insertErr)
	}
}

// fetchHetznerMetrics fetches CPU and network metrics from Hetzner Cloud API.
// CPU is normalized to 0-100% by dividing by vCPU count.
func (c *metricsCollector) fetchHetznerMetrics(ctx context.Context, hetznerServerIDStr string, now time.Time) (cpuPct, bwIn, bwOut float64, err error) {
	serverID, err := strconv.ParseInt(hetznerServerIDStr, 10, 64)
	if err != nil {
		return 0, 0, 0, err
	}

	vcpuCount, vcpuErr := c.getVCPUCount(ctx, serverID)
	if vcpuErr != nil {
		return 0, 0, 0, vcpuErr
	}

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

	// CPU — last value, normalized by vCPU count (e.g. 400% on 4 vCPU -> 100%)
	if cpuValues, ok := result.TimeSeries["cpu"]; ok && len(cpuValues) > 0 {
		lastVal := cpuValues[len(cpuValues)-1]
		rawCPU, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil && vcpuCount > 0 {
			cpuPct = rawCPU / float64(vcpuCount)
		}
	}

	if inValues, ok := result.TimeSeries["network.0.bandwidth.in"]; ok && len(inValues) > 0 {
		lastVal := inValues[len(inValues)-1]
		parsed, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil {
			bwIn = parsed
		}
	}

	if outValues, ok := result.TimeSeries["network.0.bandwidth.out"]; ok && len(outValues) > 0 {
		lastVal := outValues[len(outValues)-1]
		parsed, parseErr := strconv.ParseFloat(lastVal.Value, 64)
		if parseErr == nil {
			bwOut = parsed
		}
	}

	return cpuPct, bwIn, bwOut, nil
}

// getVCPUCount returns the vCPU count for a Hetzner server, caching on first lookup.
func (c *metricsCollector) getVCPUCount(ctx context.Context, serverID int64) (int, error) {
	if count, ok := c.vcpuCache[serverID]; ok {
		return count, nil
	}

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

// insertUnavailable records an available=false entry for downtime tracking.
func (c *metricsCollector) insertUnavailable(ctx context.Context, instanceID string) {
	snapshot := &models.MetricsSnapshot{
		InstanceID: instanceID,
		Available:  false,
	}

	if err := c.historyRepo.Insert(ctx, snapshot); err != nil {
		log.Printf("[metrics-collector] insert unavailable error for %s: %v", instanceID, err)
	}
}
