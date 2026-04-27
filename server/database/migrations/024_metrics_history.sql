-- 024: Historical LiveKit metrics table.
--
-- Stores periodic metric snapshots so the platform admin can do
-- capacity planning. The MetricsCollector background service pulls
-- Prometheus metrics from every platform-managed LiveKit instance
-- every 5 minutes and writes them to this table.
--
-- cpu_pct and bandwidth_*_bps are computed at collection time
-- from Prometheus counter deltas.
-- Records older than 30 days are purged automatically.

CREATE TABLE IF NOT EXISTS livekit_metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES livekit_instances(id) ON DELETE CASCADE,

    -- Raw Prometheus values
    room_count INTEGER NOT NULL DEFAULT 0,
    participant_count INTEGER NOT NULL DEFAULT 0,
    memory_bytes INTEGER NOT NULL DEFAULT 0,
    goroutines INTEGER NOT NULL DEFAULT 0,
    bytes_in INTEGER NOT NULL DEFAULT 0,
    bytes_out INTEGER NOT NULL DEFAULT 0,

    -- Derived metrics (computed from counter deltas)
    cpu_pct REAL NOT NULL DEFAULT 0,             -- CPU usage % (process_cpu_seconds_total delta)
    bandwidth_in_bps REAL NOT NULL DEFAULT 0,    -- Inbound bytes/sec (livekit_packet_bytes delta)
    bandwidth_out_bps REAL NOT NULL DEFAULT 0,   -- Outbound bytes/sec (livekit_packet_bytes delta)

    -- /metrics endpoint reachability state
    available INTEGER NOT NULL DEFAULT 1,

    collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Composite index for time-range queries (instance_id + collected_at)
CREATE INDEX IF NOT EXISTS idx_metrics_history_instance_time
    ON livekit_metrics_history(instance_id, collected_at);
