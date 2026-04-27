-- Link preview cache — Open Graph metadata.
-- Deduplicated cache keyed by URL, prevents repeated fetches.
-- Rows with error=1 represent failed fetches (suppresses refetch).
CREATE TABLE IF NOT EXISTS link_previews (
    url         TEXT PRIMARY KEY,
    title       TEXT,
    description TEXT,
    image_url   TEXT,
    site_name   TEXT,
    favicon_url TEXT,
    fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
    error       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_link_previews_fetched_at ON link_previews(fetched_at);
