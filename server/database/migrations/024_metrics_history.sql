-- 024: Tarihsel LiveKit metrik tablosu.
--
-- Platform admin'in kapasite planlaması yapabilmesi için periyodik
-- metrik snapshot'ları saklar. MetricsCollector arka plan servisi
-- her 5 dakikada tüm platform-managed LiveKit instance'lardan
-- Prometheus metrikleri çeker ve bu tabloya yazar.
--
-- cpu_pct ve bandwidth_*_bps değerleri collection time'da
-- Prometheus counter delta'larından hesaplanır.
-- 30 günden eski kayıtlar otomatik purge edilir.

CREATE TABLE IF NOT EXISTS livekit_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES livekit_instances(id) ON DELETE CASCADE,

    -- Ham Prometheus değerleri
    room_count INTEGER NOT NULL DEFAULT 0,
    participant_count INTEGER NOT NULL DEFAULT 0,
    memory_bytes INTEGER NOT NULL DEFAULT 0,
    goroutines INTEGER NOT NULL DEFAULT 0,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,

    -- Derived metrikler (counter delta'larından hesaplanır)
    cpu_pct REAL NOT NULL DEFAULT 0,             -- CPU kullanım % (process_cpu_seconds_total delta)
    bandwidth_in_bps REAL NOT NULL DEFAULT 0,    -- Gelen bytes/sec (livekit_packet_bytes delta)
    bandwidth_out_bps REAL NOT NULL DEFAULT 0,   -- Giden bytes/sec (livekit_packet_bytes delta)

    -- /metrics erişilebilirlik durumu
    available INTEGER NOT NULL DEFAULT 1,

    collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Zaman aralığı sorguları için composite index (instance_id + collected_at)
CREATE INDEX IF NOT EXISTS idx_metrics_history_instance_time
    ON livekit_metrics_history(instance_id, collected_at);
