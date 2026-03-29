-- Add screen_share_count column to metrics history for time-series tracking.
ALTER TABLE livekit_metrics_history ADD COLUMN screen_share_count INTEGER NOT NULL DEFAULT 0;
