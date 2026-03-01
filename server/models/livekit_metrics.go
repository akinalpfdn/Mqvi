// Package models — LiveKitInstanceMetrics, Prometheus /metrics endpoint'inden
// parse edilen LiveKit sunucu metrikleri.
//
// Admin panelde her LiveKit instance'ın anlık kaynak kullanımını göstermek için
// kullanılır. Metrikler Prometheus text exposition format'ından parse edilir.
//
// Temel metrik kaynakları:
// - livekit_node_*: LiveKit'in kendi raporladığı metrikler (CPU load, room/participant sayısı)
// - process_*: Go runtime process metrikleri (RSS memory)
// - Bandwidth: livekit_node_bytes_in/out, packets_in/out
package models

import "time"

// LiveKitInstanceMetrics, bir LiveKit instance'ın anlık kaynak kullanım metrikleri.
// Prometheus /metrics endpoint'inden parse edilen değerler.
type LiveKitInstanceMetrics struct {
	// Sistem kaynakları
	CPULoad    float64 `json:"cpu_load"`    // 0-1 arası, livekit_node_sys_cpu_load
	NumCPUs    int     `json:"num_cpus"`    // livekit_node_sys_cpus
	MemoryUsed uint64  `json:"memory_used"` // bytes, process_resident_memory_bytes
	MemoryLoad float64 `json:"memory_load"` // 0-1 arası, livekit_node_sys_memory_load

	// LiveKit kullanım metrikleri
	RoomCount          int `json:"room_count"`           // livekit_node_rooms
	ParticipantCount   int `json:"participant_count"`    // livekit_node_participants
	TrackPublishCount  int `json:"track_publish_count"`  // livekit_node_published_tracks
	TrackSubscribeCount int `json:"track_subscribe_count"` // livekit_node_subscribed_tracks

	// Bandwidth (sunucu başlangıcından itibaren toplam)
	BytesIn    uint64 `json:"bytes_in"`    // livekit_node_bytes_in_total
	BytesOut   uint64 `json:"bytes_out"`   // livekit_node_bytes_out_total
	PacketsIn  uint64 `json:"packets_in"`  // livekit_node_packets_in_total
	PacketsOut uint64 `json:"packets_out"` // livekit_node_packets_out_total
	NackTotal  uint64 `json:"nack_total"`  // livekit_node_nack_total

	// Fetch zamanı — client'ın ne kadar taze olduğunu bilmesi için
	FetchedAt time.Time `json:"fetched_at"`

	// Bağlantı durumu — /metrics erişilemezse false
	Available bool `json:"available"`
}
