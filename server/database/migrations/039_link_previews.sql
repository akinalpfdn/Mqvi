-- Link preview cache — Open Graph metadata.
-- URL bazlı deduplicated cache, tekrar fetch önlenir.
-- error=1 olan kayıtlar başarısız fetch'leri temsil eder (refetch engelleme).
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
