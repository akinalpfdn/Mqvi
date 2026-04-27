-- 038: Hetzner Cloud server ID field added to LiveKit instances.
--
-- hetzner_server_id: The server's numeric ID in the Hetzner Cloud API (as a string).
-- Empty string = no Hetzner integration, only LiveKit /metrics is used.
-- This field is required for MetricsCollector to fetch CPU and network metrics
-- from the Hetzner API.

ALTER TABLE livekit_instances ADD COLUMN hetzner_server_id TEXT NOT NULL DEFAULT '';
