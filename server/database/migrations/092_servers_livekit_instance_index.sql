-- Load and capacity for a LiveKit instance are counted live off this column, not from the stored
-- server_count (which drifts). Since GEO-05 that count runs when a voice channel claims an
-- instance, so an unindexed scan of `servers` now sits on a join path rather than only on server
-- creation. EXPLAIN QUERY PLAN showed two full SCAN servers per candidate instance.
CREATE INDEX IF NOT EXISTS idx_servers_livekit_instance
    ON servers(livekit_instance_id);
