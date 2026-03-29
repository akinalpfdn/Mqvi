package models

import "time"

// MetricsSnapshot — single historical metrics record written to DB periodically.
// Derived fields (CPUPercent, BandwidthInBps, BandwidthOutBps) are computed
// from Prometheus counter deltas at collection time.
type MetricsSnapshot struct {
	ID               int64     `json:"id"`
	InstanceID       string    `json:"instance_id"`
	RoomCount        int       `json:"room_count"`
	ParticipantCount int       `json:"participant_count"`
	MemoryBytes      uint64    `json:"memory_bytes"`
	Goroutines       int       `json:"goroutines"`
	BytesIn          uint64    `json:"bytes_in"`
	BytesOut         uint64    `json:"bytes_out"`
	ScreenShareCount int       `json:"screen_share_count"`
	CPUPercent       float64   `json:"cpu_pct"`
	BandwidthInBps   float64   `json:"bandwidth_in_bps"`
	BandwidthOutBps  float64   `json:"bandwidth_out_bps"`
	Available        bool      `json:"available"`
	CollectedAt      time.Time `json:"collected_at"`
}

// MetricsHistorySummary — aggregated metrics (MAX, AVG) for a time window.
// Used in admin panel for capacity planning.
type MetricsHistorySummary struct {
	Period      string `json:"period"` // "24h", "7d", "30d"
	SampleCount int    `json:"sample_count"`

	PeakParticipants int     `json:"peak_participants"`
	AvgParticipants  float64 `json:"avg_participants"`
	PeakRooms        int     `json:"peak_rooms"`
	AvgRooms         float64 `json:"avg_rooms"`

	PeakMemoryBytes uint64 `json:"peak_memory_bytes"`
	AvgMemoryBytes  uint64 `json:"avg_memory_bytes"`

	PeakCPUPercent float64 `json:"peak_cpu_pct"`
	AvgCPUPercent  float64 `json:"avg_cpu_pct"`

	PeakBandwidthIn  float64 `json:"peak_bandwidth_in_bps"`
	AvgBandwidthIn   float64 `json:"avg_bandwidth_in_bps"`
	PeakBandwidthOut float64 `json:"peak_bandwidth_out_bps"`
	AvgBandwidthOut  float64 `json:"avg_bandwidth_out_bps"`

	PeakGoroutines int     `json:"peak_goroutines"`
	AvgGoroutines  float64 `json:"avg_goroutines"`
}

// MetricsTimeSeriesPoint — single data point for admin dashboard charts.
type MetricsTimeSeriesPoint struct {
	Timestamp       time.Time `json:"ts"`
	CPUPercent      float64   `json:"cpu_pct"`
	BandwidthInBps  float64   `json:"bw_in"`
	BandwidthOutBps float64   `json:"bw_out"`
	Participants    int       `json:"participants"`
	MemoryBytes     uint64    `json:"memory_bytes"`
	ScreenShares    int       `json:"screen_shares"`
}
