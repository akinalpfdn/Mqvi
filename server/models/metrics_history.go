// Package models — MetricsSnapshot ve MetricsHistorySummary, tarihsel LiveKit
// metrik verileri için model tanımları.
//
// MetricsSnapshot: MetricsCollector tarafından periyodik olarak toplanan
// tek bir metrik kaydı. Her 5 dakikada bir DB'ye yazılır.
//
// MetricsHistorySummary: SQL aggregate sorguları ile hesaplanan özet.
// Admin panelde kapasite planlaması için peak/average değerler gösterilir.
package models

import "time"

// MetricsSnapshot, tek bir tarihsel metrik kaydı.
// MetricsCollector tarafından periyodik olarak üretilir ve DB'ye yazılır.
// Derived alanlar (CPUPercent, BandwidthInBps, BandwidthOutBps)
// collection time'da Prometheus counter delta'larından hesaplanır.
type MetricsSnapshot struct {
	ID               int64     `json:"id"`
	InstanceID       string    `json:"instance_id"`
	RoomCount        int       `json:"room_count"`
	ParticipantCount int       `json:"participant_count"`
	MemoryBytes      uint64    `json:"memory_bytes"`
	Goroutines       int       `json:"goroutines"`
	BytesIn          uint64    `json:"bytes_in"`
	BytesOut         uint64    `json:"bytes_out"`
	CPUPercent       float64   `json:"cpu_pct"`
	BandwidthInBps   float64   `json:"bandwidth_in_bps"`
	BandwidthOutBps  float64   `json:"bandwidth_out_bps"`
	Available        bool      `json:"available"`
	CollectedAt      time.Time `json:"collected_at"`
}

// MetricsHistorySummary, belirli bir zaman aralığı için özetlenmiş metrikler.
// SQL aggregate sorguları (MAX, AVG) ile hesaplanır.
// Admin panelde kapasite planlaması için kullanılır.
type MetricsHistorySummary struct {
	// Hangi zaman aralığı: "24h", "7d", "30d"
	Period      string `json:"period"`
	SampleCount int    `json:"sample_count"`

	// Katılımcı & Oda
	PeakParticipants int     `json:"peak_participants"`
	AvgParticipants  float64 `json:"avg_participants"`
	PeakRooms        int     `json:"peak_rooms"`
	AvgRooms         float64 `json:"avg_rooms"`

	// Bellek
	PeakMemoryBytes uint64 `json:"peak_memory_bytes"`
	AvgMemoryBytes  uint64 `json:"avg_memory_bytes"`

	// CPU kullanımı (%)
	PeakCPUPercent float64 `json:"peak_cpu_pct"`
	AvgCPUPercent  float64 `json:"avg_cpu_pct"`

	// Bandwidth (bytes/sec)
	PeakBandwidthIn  float64 `json:"peak_bandwidth_in_bps"`
	AvgBandwidthIn   float64 `json:"avg_bandwidth_in_bps"`
	PeakBandwidthOut float64 `json:"peak_bandwidth_out_bps"`
	AvgBandwidthOut  float64 `json:"avg_bandwidth_out_bps"`

	// Goroutines
	PeakGoroutines int     `json:"peak_goroutines"`
	AvgGoroutines  float64 `json:"avg_goroutines"`
}
