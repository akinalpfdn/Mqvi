-- Where a LiveKit instance physically is, so a call can be placed near the people in it.
--
-- Empty means "unknown", which is the honest state for every instance that existed before this
-- column and the safe one for selection: an instance with no region is never chosen *for* being
-- near, it just remains eligible on load like it always was.
ALTER TABLE livekit_instances ADD COLUMN region TEXT NOT NULL DEFAULT '';

-- Selection reads "instances in region X with capacity", so the region leads the index.
CREATE INDEX IF NOT EXISTS idx_livekit_instances_region
    ON livekit_instances(region, is_platform_managed);
