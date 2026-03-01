// Package models — LiveKitInstanceMetrics, Prometheus /metrics endpoint'inden
// parse edilen LiveKit sunucu metrikleri.
//
// Admin panelde her LiveKit instance'ın anlık kaynak kullanımını göstermek için
// kullanılır. Metrikler Prometheus text exposition format'ından parse edilir.
//
// Temel metrik kaynakları:
//   - livekit_room_total, livekit_participant_total: LiveKit oda/katılımcı sayıları
//   - livekit_track_*: Publish/subscribe track sayıları
//   - livekit_packet_bytes, livekit_packet_total: Bandwidth (direction label'lı)
//   - livekit_nack_total: NACK sayısı
//   - process_resident_memory_bytes: RSS bellek (Go standard metric)
//   - go_goroutines: Aktif goroutine sayısı (yük göstergesi)
package models

import "time"

// LiveKitInstanceMetrics, bir LiveKit instance'ın anlık kaynak kullanım metrikleri.
// Prometheus /metrics endpoint'inden parse edilen değerler.
type LiveKitInstanceMetrics struct {
	// Process metrikleri (Go standard Prometheus collector)
	Goroutines int    `json:"goroutines"`  // go_goroutines — aktif goroutine sayısı (yük göstergesi)
	MemoryUsed uint64 `json:"memory_used"` // process_resident_memory_bytes (RSS)

	// LiveKit kullanım metrikleri
	RoomCount           int `json:"room_count"`            // livekit_room_total
	ParticipantCount    int `json:"participant_count"`     // livekit_participant_total
	TrackPublishCount   int `json:"track_publish_count"`   // livekit_track_published_total (sum of all kinds)
	TrackSubscribeCount int `json:"track_subscribe_count"` // livekit_track_subscribed_total (sum of all kinds)

	// Bandwidth (sunucu başlangıcından itibaren toplam)
	BytesIn    uint64 `json:"bytes_in"`    // livekit_packet_bytes{direction="incoming"}
	BytesOut   uint64 `json:"bytes_out"`   // livekit_packet_bytes{direction="outgoing"}
	PacketsIn  uint64 `json:"packets_in"`  // livekit_packet_total{direction="incoming"}
	PacketsOut uint64 `json:"packets_out"` // livekit_packet_total{direction="outgoing"}
	NackTotal  uint64 `json:"nack_total"`  // livekit_nack_total

	// Fetch zamanı — client'ın ne kadar taze olduğunu bilmesi için
	FetchedAt time.Time `json:"fetched_at"`

	// Bağlantı durumu — /metrics erişilemezse false
	Available bool `json:"available"`
}
