package models

import "time"

// LiveKitInstanceMetrics — real-time resource usage parsed from Prometheus /metrics endpoint.
type LiveKitInstanceMetrics struct {
	// Process metrics (Go standard Prometheus collector)
	Goroutines int    `json:"goroutines"`  // go_goroutines
	MemoryUsed uint64 `json:"memory_used"` // process_resident_memory_bytes (RSS)

	// LiveKit usage
	RoomCount           int `json:"room_count"`            // livekit_room_total
	ParticipantCount    int `json:"participant_count"`     // livekit_participant_total
	TrackPublishCount   int `json:"track_publish_count"`   // livekit_track_published_total
	TrackSubscribeCount int `json:"track_subscribe_count"` // livekit_track_subscribed_total

	// Bandwidth (cumulative counters since server start)
	BytesIn    uint64 `json:"bytes_in"`    // livekit_packet_bytes{direction="incoming"}
	BytesOut   uint64 `json:"bytes_out"`   // livekit_packet_bytes{direction="outgoing"}
	PacketsIn  uint64 `json:"packets_in"`  // livekit_packet_total{direction="incoming"}
	PacketsOut uint64 `json:"packets_out"` // livekit_packet_total{direction="outgoing"}
	NackTotal  uint64 `json:"nack_total"`  // livekit_nack_total

	// Hetzner Cloud API metrics (populated only when Hetzner is configured)
	CPUPercent      float64 `json:"cpu_pct"`
	BandwidthInBps  float64 `json:"bw_in_bps"`
	BandwidthOutBps float64 `json:"bw_out_bps"`
	HetznerAvail    bool    `json:"hetzner_avail"`

	// Screen share stats (from voice service, not Prometheus)
	ScreenShareCount int `json:"screen_share_count"` // active streamers
	ScreenShareViewers int `json:"screen_share_viewers"` // total viewers watching

	FetchedAt time.Time `json:"fetched_at"`
	Available bool      `json:"available"` // true if at least one source was reachable
}
